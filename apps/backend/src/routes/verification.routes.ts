/**
 * Verification routes — host identity and listing verification workflow.
 * Issue #845
 *
 * User-facing (authenticated):
 *   POST   /api/v1/verification/requests                       — Submit request
 *   GET    /api/v1/verification/requests                       — List own requests
 *   GET    /api/v1/verification/requests/:id                   — Get own request
 *   POST   /api/v1/verification/requests/:id/evidence          — Add evidence metadata
 *   POST   /api/v1/verification/requests/:id/withdraw          — Withdraw request
 *   POST   /api/v1/verification/requests/:id/appeal            — Appeal rejection
 *
 * Public (no auth required):
 *   GET    /api/v1/verification/badges/user/:userId            — Public badges for user
 *   GET    /api/v1/verification/badges/property/:propertyId    — Badges for property's host
 */

import { Router } from 'express';
import { authenticate } from '@/middleware/auth.middleware.js';
import { createUserRateLimiter } from '@/middleware/rateLimiter.js';
import {
  createVerificationHandler,
  listOwnVerificationsHandler,
  getOwnVerificationHandler,
  addEvidenceHandler,
  withdrawHandler,
  appealHandler,
  getPublicBadgesHandler,
  getPropertyHostBadgesHandler,
} from '@/controllers/verification.controller.js';

const router = Router();

/** Rate-limit verification submissions: max 5 per user per day. */
const submissionLimiter = createUserRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  keyPrefix: 'rl:verification:submit',
});

// ── Public badge endpoints ───────────────────────────────────────────────────
// Unauthenticated: public badge data only, no PII exposed.

router.get('/badges/user/:userId', getPublicBadgesHandler);
router.get('/badges/property/:propertyId', getPropertyHostBadgesHandler);

// ── Authenticated user endpoints ─────────────────────────────────────────────
router.use(authenticate);

/**
 * POST /api/v1/verification/requests
 * Submit a new identity or listing verification request.
 * Body: { verification_type: 'identity' | 'listing', property_id?: string }
 */
router.post('/requests', submissionLimiter, createVerificationHandler);

/**
 * GET /api/v1/verification/requests
 * List the authenticated user's own verification requests.
 */
router.get('/requests', listOwnVerificationsHandler);

/**
 * GET /api/v1/verification/requests/:id
 * Get a single verification request (must be the owner).
 */
router.get('/requests/:id', getOwnVerificationHandler);

/**
 * POST /api/v1/verification/requests/:id/evidence
 * Add evidence metadata to a request. The actual file is uploaded to
 * Supabase Storage by the client; this records the metadata reference.
 * Body: { evidence_type, storage_path, mime_type?, file_size_bytes? }
 */
router.post('/requests/:id/evidence', addEvidenceHandler);

/**
 * POST /api/v1/verification/requests/:id/withdraw
 * Withdraw a pending or under-review request.
 */
router.post('/requests/:id/withdraw', withdrawHandler);

/**
 * POST /api/v1/verification/requests/:id/appeal
 * Appeal a rejected verification request (max 3 appeals).
 */
router.post('/requests/:id/appeal', appealHandler);

export default router;
