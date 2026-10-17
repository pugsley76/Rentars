/**
 * Verification controller — host identity and listing verification workflow.
 *
 * User-facing endpoints (authenticated):
 *   POST   /api/v1/verification/requests              — Submit a verification request
 *   GET    /api/v1/verification/requests              — List own verification requests
 *   GET    /api/v1/verification/requests/:id          — Get own verification request
 *   POST   /api/v1/verification/requests/:id/evidence — Upload evidence metadata
 *   POST   /api/v1/verification/requests/:id/withdraw — Withdraw a request
 *   POST   /api/v1/verification/requests/:id/appeal   — Appeal a rejected request
 *   GET    /api/v1/verification/badges/:userId         — Get public badges for a user
 *   GET    /api/v1/verification/badges/property/:propId — Get public badges for a property's host
 *
 * Admin/moderator endpoints (requireScope):
 *   GET    /api/v1/admin/verification/requests         — List requests for review
 *   GET    /api/v1/admin/verification/requests/:id     — Get request with evidence
 *   POST   /api/v1/admin/verification/requests/:id/review — Review (approve/reject/needs_info)
 *   POST   /api/v1/admin/verification/badges/:id/revoke  — Revoke a badge
 */

import type { Response } from 'express';
import { z } from 'zod';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import type { AdminRequest } from '@/middleware/adminScope.middleware.js';
import {
  createVerificationRequest,
  addEvidence,
  getUserVerifications,
  getVerificationRequest,
  withdrawVerificationRequest,
  appealVerificationRequest,
  getUserBadges,
  getPropertyHostBadges,
  listVerificationRequestsForReview,
  getVerificationRequestForReview,
  reviewVerificationRequest,
  revokeBadge,
  type VerificationType,
  type ReviewDecision,
  type EvidenceType,
} from '@/services/verification.service.js';

// ─── Schemas ──────────────────────────────────────────────────────────────────

const createRequestSchema = z.object({
  verification_type: z.enum(['identity', 'listing']),
  property_id: z.string().uuid().optional().nullable(),
});

const addEvidenceSchema = z.object({
  evidence_type: z.enum([
    'government_id', 'selfie', 'proof_of_address',
    'property_ownership', 'property_photos', 'utility_bill',
    'business_license', 'other',
  ]),
  storage_path: z.string().min(1),
  mime_type: z.string().optional(),
  file_size_bytes: z.number().int().positive().optional(),
});

const reviewSchema = z.object({
  decision: z.enum(['approved', 'rejected', 'needs_more_info', 'expired', 'disputed']),
  notes: z.string().optional(),
});

const revokeBadgeSchema = z.object({
  reason: z.string().min(1, 'Reason is required'),
});

// ─── User-facing handlers ──────────────────────────────────────────────────────

export async function createVerificationHandler(
  req: AuthRequest,
  res: Response,
): Promise<void> {
  const parsed = createRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const result = await createVerificationRequest(
    req.userId!,
    parsed.data.verification_type as VerificationType,
    parsed.data.property_id ?? null,
    req.ip,
  );

  if (!result.success || !result.data) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data);
}

export async function listOwnVerificationsHandler(
  req: AuthRequest,
  res: Response,
): Promise<void> {
  const result = await getUserVerifications(req.userId!);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function getOwnVerificationHandler(
  req: AuthRequest,
  res: Response,
): Promise<void> {
  const result = await getVerificationRequest(req.params.id, req.userId!);
  if (!result.success || !result.data) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function addEvidenceHandler(
  req: AuthRequest,
  res: Response,
): Promise<void> {
  const parsed = addEvidenceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const result = await addEvidence(
    req.params.id,
    req.userId!,
    parsed.data.evidence_type as EvidenceType,
    parsed.data.storage_path,
    parsed.data.mime_type ?? 'application/octet-stream',
    parsed.data.file_size_bytes ?? 0,
    req.ip,
  );

  if (!result.success || !result.data) {
    res.status(400).json({ error: result.error });
    return;
  }

  res.status(201).json(result.data);
}

export async function withdrawHandler(
  req: AuthRequest,
  res: Response,
): Promise<void> {
  const result = await withdrawVerificationRequest(req.params.id, req.userId!, req.ip);
  if (!result.success || !result.data) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function appealHandler(
  req: AuthRequest,
  res: Response,
): Promise<void> {
  const result = await appealVerificationRequest(req.params.id, req.userId!, req.ip);
  if (!result.success || !result.data) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function getPublicBadgesHandler(
  req: AuthRequest,
  res: Response,
): Promise<void> {
  // Anyone can read public badges — no auth strictly required, but if
  // authenticated we still return the same public data.
  const result = await getUserBadges(req.params.userId);
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function getPropertyHostBadgesHandler(
  req: AuthRequest,
  res: Response,
): Promise<void> {
  const result = await getPropertyHostBadges(req.params.propertyId);
  if (!result.success) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

// ─── Admin/moderator handlers ─────────────────────────────────────────────────

export async function adminListVerificationsHandler(
  req: AdminRequest,
  res: Response,
): Promise<void> {
  const status = (req.query.status as string) || undefined;
  const type = (req.query.type as string) || undefined;

  const result = await listVerificationRequestsForReview(
    status as any,
    type as any,
  );
  if (!result.success) {
    res.status(500).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function adminGetVerificationHandler(
  req: AdminRequest,
  res: Response,
): Promise<void> {
  const result = await getVerificationRequestForReview(req.params.id);
  if (!result.success || !result.data) {
    res.status(404).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function adminReviewHandler(
  req: AdminRequest,
  res: Response,
): Promise<void> {
  const parsed = reviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const result = await reviewVerificationRequest(
    req.params.id,
    req.adminId!,
    parsed.data.decision as ReviewDecision,
    parsed.data.notes ?? null,
    req.ip,
  );

  if (!result.success || !result.data) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json(result.data);
}

export async function adminRevokeBadgeHandler(
  req: AdminRequest,
  res: Response,
): Promise<void> {
  const parsed = revokeBadgeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', details: parsed.error.flatten().fieldErrors } });
    return;
  }

  const result = await revokeBadge(req.params.id, req.adminId!, parsed.data.reason, req.ip);
  if (!result.success) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ message: 'Badge revoked.' });
}
