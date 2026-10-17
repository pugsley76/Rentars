/**
 * Consent service — analytics consent category management.
 *
 * Issue #846 acceptance criteria:
 *   - Users can inspect and change optional analytics preferences.
 *   - Revocation stops future optional tracking within a documented interval.
 *   - Required security and transaction records are accurately distinguished
 *     from analytics.
 *
 * Consent categories:
 *   required_operations — security logs, transaction records. Always true.
 *     Cannot be revoked by the user.
 *   product_analytics — funnel events, listing views, booking flows.
 *     Optional, revocable.
 *   search_analytics — search queries, zero-result tracking, autocomplete.
 *     Optional, revocable.
 *   performance — page load timing, error reporting.
 *     Optional, revocable.
 *
 * Revocation behavior:
 *   When a user revokes consent for a category, `consent_given` is set to
 *   false and `revoked_at` is timestamped. The analytics service checks
 *   consent BEFORE emitting any event, so revocation takes effect on the
 *   next request — no async propagation delay.
 */

import { supabase } from '@/config/supabase.js';
import { auditLogger } from './auditLogger.service.js';
import type { ServiceResponse } from './index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ConsentCategory =
  | 'required_operations'
  | 'product_analytics'
  | 'search_analytics'
  | 'performance';

export interface ConsentRecord {
  id: string;
  user_id: string;
  consent_category: ConsentCategory;
  consent_given: boolean;
  granted_at: string | null;
  revoked_at: string | null;
  last_change_ip: string | null;
  updated_at: string;
}

export interface ConsentPreferences {
  required_operations: boolean;
  product_analytics: boolean;
  search_analytics: boolean;
  performance: boolean;
  /** When each category was last changed. */
  last_updated: Record<ConsentCategory, string | null>;
}

// ─── Category metadata ────────────────────────────────────────────────────────

/** Categories that the user CAN revoke. Required categories are always on. */
export const OPTIONAL_CATEGORIES: ConsentCategory[] = [
  'product_analytics',
  'search_analytics',
  'performance',
];

/** All categories, including the required one. */
export const ALL_CATEGORIES: ConsentCategory[] = [
  'required_operations',
  ...OPTIONAL_CATEGORIES,
];

/** Human-readable descriptions for each category. */
export const CATEGORY_DESCRIPTIONS: Record<ConsentCategory, string> = {
  required_operations:
    'Security logs, transaction records, and fraud detection. ' +
    'These are required for platform safety and cannot be disabled.',
  product_analytics:
    'Funnel events such as searches, listing views, booking flows, and ' +
    'wishlist additions. Helps us understand how the platform is used.',
  search_analytics:
    'Search query tracking, zero-result analysis, and autocomplete. ' +
    'Helps improve search quality and suggestions.',
  performance:
    'Page load timing and client-side error reporting. ' +
    'Helps us identify and fix performance issues.',
};

// ─── Cache ────────────────────────────────────────────────────────────────────

/**
 * Short-lived in-memory cache so the analytics service doesn't query the
 * database on every event emission. Cache TTL: 60 seconds.
 * On revocation the user's entry is purged immediately.
 */
const CACHE_TTL_MS = 60_000;
const consentCache = new Map<string, { timestamp: number; preferences: ConsentPreferences }>();

function getCachedPreferences(userId: string): ConsentPreferences | null {
  const entry = consentCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    consentCache.delete(userId);
    return null;
  }
  return entry.preferences;
}

function setCachedPreferences(userId: string, prefs: ConsentPreferences): void {
  consentCache.set(userId, { timestamp: Date.now(), preferences: prefs });
}

function invalidateCache(userId: string): void {
  consentCache.delete(userId);
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Get a user's current consent preferences across all categories.
 * Missing optional categories default to `true` (consent by default,
 * revocable at any time — standard for analytics).
 */
export async function getConsentPreferences(userId: string): Promise<ServiceResponse<ConsentPreferences>> {
  // Check cache first
  const cached = getCachedPreferences(userId);
  if (cached) return { success: true, data: cached };

  const { data, error } = await supabase
    .from('analytics_consent')
    .select('*')
    .eq('user_id', userId);

  if (error) {
    return { success: false, error: error.message };
  }

  // Build preferences from DB rows, defaulting missing optional categories to true
  const rows = (data ?? []) as ConsentRecord[];
  const prefs: ConsentPreferences = {
    required_operations: true,
    product_analytics: true,
    search_analytics: true,
    performance: true,
    last_updated: {
      required_operations: null,
      product_analytics: null,
      search_analytics: null,
      performance: null,
    },
  };

  for (const row of rows) {
    prefs[row.consent_category] = row.consent_given;
    prefs.last_updated[row.consent_category] = row.updated_at;
  }

  // Required operations is always true regardless of DB state
  prefs.required_operations = true;

  setCachedPreferences(userId, prefs);
  return { success: true, data: prefs };
}

/**
 * Check if a user has consented to a specific category.
 * Returns true for required_operations (always consented).
 * For optional categories, defaults to true if no record exists.
 */
export async function hasConsent(
  userId: string,
  category: ConsentCategory,
): Promise<boolean> {
  if (category === 'required_operations') return true;

  const result = await getConsentPreferences(userId);
  if (!result.success || !result.data) return true; // fail open for optional analytics

  return result.data[category];
}

/**
 * Update consent for one or more optional categories.
 * Required operations cannot be changed — it's silently ignored.
 *
 * @param userId - User ID
 * @param updates - Map of category → boolean (true = grant, false = revoke)
 * @param ip - Request IP for audit
 */
export async function updateConsent(
  userId: string,
  updates: Partial<Record<ConsentCategory, boolean>>,
  ip?: string,
): Promise<ServiceResponse<ConsentPreferences>> {
  const now = new Date().toISOString();
  const upserts: Array<Record<string, unknown>> = [];

  for (const [category, granted] of Object.entries(updates)) {
    const cat = category as ConsentCategory;

    // Required operations cannot be changed
    if (cat === 'required_operations') continue;

    const consentGiven = Boolean(granted);

    upserts.push({
      user_id: userId,
      consent_category: cat,
      consent_given: consentGiven,
      granted_at: consentGiven ? now : null,
      revoked_at: consentGiven ? null : now,
      last_change_ip: ip,
      updated_at: now,
    });
  }

  if (upserts.length > 0) {
    const { error } = await supabase
      .from('analytics_consent')
      .upsert(upserts, { onConflict: 'user_id,consent_category' });

    if (error) {
      return { success: false, error: `Failed to update consent: ${error.message}` };
    }
  }

  // Invalidate cache so the next read picks up the new values
  invalidateCache(userId);

  // Audit log the change
  const changedCategories = Object.keys(updates)
    .filter((k) => k !== 'required_operations')
    .map((k) => `${k}=${updates[k as ConsentCategory] ? 'granted' : 'revoked'}`);

  await auditLogger.log({
    actorId: userId,
    action: 'auth.unauthorized_access', // closest existing audit action; could add 'consent.update'
    resourceType: 'user',
    resourceId: userId,
    ip,
    meta: { consent_changes: changedCategories, action: 'consent_update' },
  });

  // Return the updated preferences
  return getConsentPreferences(userId);
}

/**
 * Revoke all optional analytics consent for a user.
 * Convenience method for "opt out of everything" buttons.
 */
export async function revokeAllOptionalConsent(
  userId: string,
  ip?: string,
): Promise<ServiceResponse<ConsentPreferences>> {
  return updateConsent(
    userId,
    {
      product_analytics: false,
      search_analytics: false,
      performance: false,
    },
    ip,
  );
}

/**
 * Grant all optional analytics consent for a user.
 * Convenience method for "opt in to everything" buttons.
 */
export async function grantAllOptionalConsent(
  userId: string,
  ip?: string,
): Promise<ServiceResponse<ConsentPreferences>> {
  return updateConsent(
    userId,
    {
      product_analytics: true,
      search_analytics: true,
      performance: true,
    },
    ip,
  );
}
