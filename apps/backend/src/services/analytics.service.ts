/**
 * Analytics service — funnel event emission.
 *
 * Implements the event taxonomy defined in docs/ANALYTICS_TAXONOMY.md.
 *
 * Rules:
 *  - Booking and payment events are emitted server-side after confirmed
 *    state changes.  Never trust client-emitted funnel events.
 *  - user_id is omitted when the user has opted out or is unauthenticated.
 *  - Properties must not contain USDC amounts, wallet private keys,
 *    message content, or raw PII beyond what the taxonomy allows.
 *  - Every emit call is fire-and-forget: analytics failures must never
 *    block request handlers.  Errors are logged at warn level.
 *  - Events are schema-validated before insert; invalid events are
 *    discarded and logged.
 */

import { supabase } from '@/config/supabase.js';
import { structuredLog } from '@/middleware/logging.middleware.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EventName =
  | 'search.executed'
  | 'search.zero_results'
  | 'search.suggestion_accepted'
  | 'listing.viewed'
  | 'listing.wishlisted'
  | 'booking.initiated'
  | 'booking.confirmed'
  | 'booking.cancelled'
  | 'payment.escrow_funded'
  | 'payment.escrow_released'
  | 'payment.escrow_refunded'
  | 'payment.escrow_failed'
  | 'cancellation.dispute_raised';

export interface FunnelEventPayload {
  event: EventName;
  /** Pseudonymous session identifier (never wallet address or email). */
  session_id: string;
  /** Omit when user is unauthenticated or has opted out. */
  user_id?: string;
  /** Event-specific properties — see taxonomy for allowed keys. */
  properties: Record<string, unknown>;
}

// ─── Opt-out check ────────────────────────────────────────────────────────────

/**
 * Returns true if the user has opted out of analytics.
 * Defaults to false (not opted out) if the preference row does not exist.
 *
 * @deprecated Use `hasConsent` from consent.service.ts for granular category
 * checks. This function is retained for backwards compatibility and checks
 * the legacy `user_analytics_preferences` table as well as the new
 * `analytics_consent` table.
 */
export async function isAnalyticsOptedOut(userId: string): Promise<boolean> {
  // Check new granular consent system first (product_analytics category)
  const { hasConsent } = await import('./consent.service.js');
  const productConsent = await hasConsent(userId, 'product_analytics');
  if (!productConsent) return true;

  // Fall back to legacy opt-out table
  const { data } = await supabase
    .from('user_analytics_preferences')
    .select('opted_out')
    .eq('user_id', userId)
    .maybeSingle();

  return data?.opted_out === true;
}

/**
 * Set or clear a user's analytics opt-out preference.
 */
export async function setAnalyticsOptOut(
  userId: string,
  optedOut: boolean,
): Promise<void> {
  await supabase
    .from('user_analytics_preferences')
    .upsert({ user_id: userId, opted_out: optedOut, updated_at: new Date().toISOString() });
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** Keys that must never appear in any analytics event properties. */
const FORBIDDEN_KEYS = [
  'secret', 'private_key', 'seed', 'mnemonic', 'password', 'password_hash',
  'access_token', 'refresh_token', 'jwt', 'authorization',
  'message', 'body', 'content',                // user-authored text
  'total_price', 'amount_usdc', 'escrow_amount', // financial amounts
  'email', 'phone', 'full_name',                 // direct PII
];

function validateProperties(properties: Record<string, unknown>): boolean {
  for (const key of Object.keys(properties)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_KEYS.some((forbidden) => lower.includes(forbidden))) {
      structuredLog({
        level: 'warn',
        message: 'Analytics event blocked: forbidden property key',
        timestamp: new Date().toISOString(),
        key,
      });
      return false;
    }
  }
  return true;
}

// ─── Core emit ────────────────────────────────────────────────────────────────

/**
 * Emit a funnel analytics event.
 *
 * Fire-and-forget: awaiting this is optional.  It swallows all errors so
 * analytics failures never propagate to the caller.
 *
 * Consent check (Issue #846): if a `user_id` is provided and the user has
 * revoked consent for the relevant analytics category, the event is silently
 * discarded. Required operational events (security, transaction records) are
 * never affected by consent — those go through audit logging, not here.
 *
 * @example
 * // In booking.service.ts, after status update succeeds:
 * void emitFunnelEvent({
 *   event: 'booking.confirmed',
 *   session_id: sessionId,
 *   user_id: tenantId,
 *   properties: { booking_id: booking.id, property_id: booking.property_id, nights },
 * });
 */
export async function emitFunnelEvent(payload: FunnelEventPayload): Promise<void> {
  try {
    if (!validateProperties(payload.properties)) return;

    // ── Consent check (Issue #846) ────────────────────────────────────────────
    // If a user_id is provided, verify they have consented to product_analytics.
    // Events without a user_id (anonymous/unauthenticated) are still emitted —
    // they carry only a pseudonymous session_id, never PII.
    if (payload.user_id) {
      const { hasConsent } = await import('./consent.service.js');
      const consented = await hasConsent(payload.user_id, 'product_analytics');
      if (!consented) {
        // User has revoked consent — silently discard the event.
        return;
      }
    }

    const { error } = await supabase.from('funnel_events').insert({
      event: payload.event,
      session_id: payload.session_id,
      user_id: payload.user_id ?? null,
      properties: payload.properties,
      created_at: new Date().toISOString(),
    });

    if (error) {
      structuredLog({
        level: 'warn',
        message: 'Analytics event insert failed',
        timestamp: new Date().toISOString(),
        event: payload.event,
        error: error.message,
      });
    }
  } catch (err) {
    structuredLog({
      level: 'warn',
      message: 'Analytics emit threw unexpectedly',
      timestamp: new Date().toISOString(),
      event: payload.event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Convenience emitters ─────────────────────────────────────────────────────
// These wrap emitFunnelEvent with typed property shapes so call-sites
// cannot accidentally pass wrong fields.

export interface SearchExecutedProps {
  query: string;
  filters?: Record<string, unknown>;
  result_count: number;
  sort_by?: string;
  page?: number;
}

export async function emitSearchExecuted(
  session_id: string,
  props: SearchExecutedProps,
  user_id?: string,
): Promise<void> {
  const event: EventName = props.result_count === 0 ? 'search.zero_results' : 'search.executed';
  return emitFunnelEvent({ event, session_id, user_id, properties: { ...props } });
}

export interface ListingViewedProps {
  property_id: string;
  referrer?: 'search' | 'wishlist' | 'direct' | 'share' | 'map';
  search_position?: number;
}

export async function emitListingViewed(
  session_id: string,
  props: ListingViewedProps,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'listing.viewed', session_id, user_id, properties: { ...props } });
}

export interface BookingInitiatedProps {
  booking_id: string;
  property_id: string;
  nights: number;
  guests: number;
  check_in: string;
  check_out: string;
}

export async function emitBookingInitiated(
  session_id: string,
  props: BookingInitiatedProps,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'booking.initiated', session_id, user_id, properties: { ...props } });
}

export interface BookingConfirmedProps {
  booking_id: string;
  property_id: string;
  nights: number;
}

export async function emitBookingConfirmed(
  session_id: string,
  props: BookingConfirmedProps,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'booking.confirmed', session_id, user_id, properties: { ...props } });
}

export interface BookingCancelledProps {
  booking_id: string;
  cancelled_by: 'tenant' | 'host' | 'system';
  reason_code?: string;
  hours_before_checkin?: number;
}

export async function emitBookingCancelled(
  session_id: string,
  props: BookingCancelledProps,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'booking.cancelled', session_id, user_id, properties: { ...props } });
}

export interface EscrowEventProps {
  booking_id: string;
  escrow_id: string;
  stellar_network?: string;
}

export async function emitEscrowFunded(
  session_id: string,
  props: EscrowEventProps,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'payment.escrow_funded', session_id, user_id, properties: { ...props } });
}

export async function emitEscrowReleased(
  session_id: string,
  props: Omit<EscrowEventProps, 'stellar_network'>,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'payment.escrow_released', session_id, user_id, properties: { ...props } });
}

export interface EscrowRefundedProps {
  booking_id: string;
  escrow_id: string;
  refund_type: 'full' | 'partial' | 'none';
}

export async function emitEscrowRefunded(
  session_id: string,
  props: EscrowRefundedProps,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'payment.escrow_refunded', session_id, user_id, properties: { ...props } });
}

export interface EscrowFailedProps {
  booking_id: string;
  operation: 'fund' | 'release' | 'refund';
  error_code?: string;
}

export async function emitEscrowFailed(
  session_id: string,
  props: EscrowFailedProps,
  user_id?: string,
): Promise<void> {
  return emitFunnelEvent({ event: 'payment.escrow_failed', session_id, user_id, properties: { ...props } });
}

// ─── Aggregate queries (used by the analytics dashboard endpoint) ─────────────

export interface FunnelSummary {
  searches: number;
  booking_initiations: number;
  booking_confirmations: number;
  escrow_funded: number;
  escrow_released: number;
  escrow_refunded: number;
  escrow_failed: number;
}

/**
 * Return aggregate funnel counts for the past N days.
 * Does not expose user_id or session_id — safe for dashboard display.
 */
export async function getFunnelSummary(days = 30): Promise<FunnelSummary> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('funnel_events')
    .select('event')
    .gte('created_at', since);

  if (error || !data) {
    structuredLog({ level: 'warn', message: 'getFunnelSummary query failed', timestamp: new Date().toISOString(), error: error?.message });
    return {
      searches: 0, booking_initiations: 0, booking_confirmations: 0,
      escrow_funded: 0, escrow_released: 0, escrow_refunded: 0, escrow_failed: 0,
    };
  }

  const count = (name: EventName) => data.filter((r) => r.event === name).length;

  return {
    searches:              count('search.executed') + count('search.zero_results'),
    booking_initiations:   count('booking.initiated'),
    booking_confirmations: count('booking.confirmed'),
    escrow_funded:         count('payment.escrow_funded'),
    escrow_released:       count('payment.escrow_released'),
    escrow_refunded:       count('payment.escrow_refunded'),
    escrow_failed:         count('payment.escrow_failed'),
  };
}
