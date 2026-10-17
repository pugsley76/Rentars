/**
 * Consent controller — analytics consent preferences.
 *
 * Issue #846: Add accessibility and privacy controls for analytics consent.
 *
 * Endpoints (authenticated):
 *   GET  /api/v1/consent                        — Get current consent preferences
 *   PUT  /api/v1/consent                        — Update consent preferences
 *   POST /api/v1/consent/revoke-all             — Revoke all optional consent
 *   POST /api/v1/consent/grant-all              — Grant all optional consent
 *
 * The response always includes all categories with descriptions so the UI can
 * render accessible controls without a separate metadata endpoint.
 */

import type { Response } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import {
  getConsentPreferences,
  updateConsent,
  revokeAllOptionalConsent,
  grantAllOptionalConsent,
  CATEGORY_DESCRIPTIONS,
  type ConsentCategory,
  type ConsentPreferences,
} from '@/services/consent.service.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

const updateConsentSchema = z
  .object({
    product_analytics: z.boolean().optional(),
    search_analytics: z.boolean().optional(),
    performance: z.boolean().optional(),
    // required_operations is silently ignored — cannot be changed
    required_operations: z.boolean().optional(),
  })
  .refine(
    (val) => Object.keys(val).some((k) => k !== 'required_operations'),
    { message: 'At least one optional category must be provided.' },
  );

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/consent
 *
 * Returns the user's current consent preferences with category descriptions.
 * Required operational consent is always `true` and marked as non-revocable.
 */
export async function getConsentHandler(req: AuthRequest, res: Response): Promise<void> {
  const result = await getConsentPreferences(req.userId!);
  if (!result.success || !result.data) {
    res.status(500).json({ error: result.error });
    return;
  }

  res.json({
    preferences: result.data,
    categories: Object.entries(CATEGORY_DESCRIPTIONS).map(([key, description]) => ({
      key: key as ConsentCategory,
      label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      description,
      revocable: key !== 'required_operations',
      value: result.data![key as ConsentCategory],
      last_updated: result.data!.last_updated[key as ConsentCategory],
    })),
  });
}

/**
 * PUT /api/v1/consent
 *
 * Update one or more consent categories. Required operations cannot be
 * changed and is silently ignored.
 *
 * Body: { product_analytics?: boolean, search_analytics?: boolean, performance?: boolean }
 */
export async function updateConsentHandler(req: AuthRequest, res: Response): Promise<void> {
  const parsed = updateConsentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  // Strip required_operations — it cannot be changed
  const updates: Partial<Record<ConsentCategory, boolean>> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (key !== 'required_operations' && typeof value === 'boolean') {
      updates[key as ConsentCategory] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No valid optional consent categories provided.' });
    return;
  }

  const result = await updateConsent(req.userId!, updates, req.ip);
  if (!result.success || !result.data) {
    res.status(500).json({ error: result.error });
    return;
  }

  res.json({
    preferences: result.data,
    message: 'Consent preferences updated.',
  });
}

/**
 * POST /api/v1/consent/revoke-all
 *
 * Revoke all optional analytics consent in one action.
 */
export async function revokeAllHandler(req: AuthRequest, res: Response): Promise<void> {
  const result = await revokeAllOptionalConsent(req.userId!, req.ip);
  if (!result.success || !result.data) {
    res.status(500).json({ error: result.error });
    return;
  }

  res.json({
    preferences: result.data,
    message: 'All optional analytics consent has been revoked. ' +
      'Required security and transaction logs are unaffected.',
  });
}

/**
 * POST /api/v1/consent/grant-all
 *
 * Grant all optional analytics consent in one action.
 */
export async function grantAllHandler(req: AuthRequest, res: Response): Promise<void> {
  const result = await grantAllOptionalConsent(req.userId!, req.ip);
  if (!result.success || !result.data) {
    res.status(500).json({ error: result.error });
    return;
  }

  res.json({
    preferences: result.data,
    message: 'All optional analytics consent has been granted.',
  });
}
