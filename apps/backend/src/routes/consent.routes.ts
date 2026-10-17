/**
 * Consent routes — analytics consent preferences (Issue #846).
 *
 * GET  /api/v1/consent             — Get current consent preferences
 * PUT  /api/v1/consent             — Update consent preferences
 * POST /api/v1/consent/revoke-all  — Revoke all optional consent
 * POST /api/v1/consent/grant-all   — Grant all optional consent
 *
 * All endpoints require authentication (consent is per-user).
 */

import { Router } from 'express';
import { authenticate } from '@/middleware/auth.middleware.js';
import { createUserRateLimiter } from '@/middleware/rateLimiter.js';
import {
  getConsentHandler,
  updateConsentHandler,
  revokeAllHandler,
  grantAllHandler,
} from '@/controllers/consent.controller.js';

const router = Router();

/** Rate-limit consent changes to prevent abuse: 30 per user per hour. */
const consentLimiter = createUserRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyPrefix: 'rl:consent',
});

router.use(authenticate);

router.get('/', getConsentHandler);
router.put('/', consentLimiter, updateConsentHandler);
router.post('/revoke-all', consentLimiter, revokeAllHandler);
router.post('/grant-all', consentLimiter, grantAllHandler);

export default router;
