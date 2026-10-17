/**
 * Verification service — host identity and listing verification workflow.
 *
 * Issue #845 acceptance criteria:
 *   - Verification status is explainable and cannot be self-assigned through
 *     request fields.
 *   - Evidence is access-controlled and retained by policy.
 *   - Public badges describe exactly what was verified and when.
 *
 * State model:
 *
 *   pending → under_review → approved → (badge granted, expires after 1 year)
 *                         → rejected → resubmitted (appeal) → pending
 *                         → needs_more_info → pending (user adds evidence)
 *
 *   Any state → withdrawn (user-initiated)
 *   approved → expired (after expiry date)
 *   Any state → disputed (escalation)
 */

import { supabase } from '@/config/supabase.js';
import { auditLogger } from './auditLogger.service.js';
import type { ServiceResponse } from './index.js';
import { v4 as uuid } from 'uuid';

// ─── Types ────────────────────────────────────────────────────────────────────

export type VerificationType = 'identity' | 'listing';
export type VerificationStatus =
  | 'pending'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'disputed'
  | 'resubmitted'
  | 'withdrawn';

export type EvidenceType =
  | 'government_id'
  | 'selfie'
  | 'proof_of_address'
  | 'property_ownership'
  | 'property_photos'
  | 'utility_bill'
  | 'business_license'
  | 'other';

export type ReviewDecision =
  | 'approved'
  | 'rejected'
  | 'needs_more_info'
  | 'expired'
  | 'disputed';

export interface VerificationRequest {
  id: string;
  user_id: string;
  verification_type: VerificationType;
  property_id: string | null;
  status: VerificationStatus;
  evidence_summary: Array<{ type: EvidenceType; uploaded_at: string }>;
  reviewer_id: string | null;
  review_notes: string | null;
  rejection_reason: string | null;
  submitted_at: string;
  reviewed_at: string | null;
  expires_at: string | null;
  appeal_count: number;
  last_appealed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VerificationBadge {
  id: string;
  user_id: string;
  property_id: string | null;
  badge_type: 'identity_verified' | 'listing_verified';
  verified_at: string;
  expires_at: string;
  is_active: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** How long a verification badge remains valid after approval. */
const BADGE_VALIDITY_DAYS = 365;

/** Maximum appeal attempts before the user must contact support. */
const MAX_APPEALS = 3;

/** Evidence retention period after a request is resolved. */
const EVIDENCE_RETENTION_DAYS = 90;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeBadgeExpiry(): string {
  return new Date(Date.now() + BADGE_VALIDITY_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function computeRetentionDeadline(): string {
  return new Date(Date.now() + EVIDENCE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

// ─── User-facing operations ───────────────────────────────────────────────────

/**
 * Create a new verification request.
 *
 * The user supplies a verification type and (for listings) a property_id.
 * The status is always set to 'pending' — it cannot be self-assigned.
 */
export async function createVerificationRequest(
  userId: string,
  verificationType: VerificationType,
  propertyId: string | null,
  ip?: string,
): Promise<ServiceResponse<VerificationRequest>> {
  // Validate: listing verification requires a property_id
  if (verificationType === 'listing' && !propertyId) {
    return { success: false, error: 'Property ID is required for listing verification.' };
  }

  // Validate: user owns the property (for listing verification)
  if (verificationType === 'listing' && propertyId) {
    const { data: property } = await supabase
      .from('properties')
      .select('owner_id')
      .eq('id', propertyId)
      .single();
    if (!property || property.owner_id !== userId) {
      return { success: false, error: 'You can only verify your own listings.' };
    }
  }

  // Check for existing active/pending verification of the same type
  const { data: existing } = await supabase
    .from('verification_requests')
    .select('id, status')
    .eq('user_id', userId)
    .eq('verification_type', verificationType)
    .eq('property_id', propertyId ?? null)
    .in('status', ['pending', 'under_review', 'approved', 'resubmitted'])
    .limit(1);

  if (existing && existing.length > 0) {
    return {
      success: false,
      error: `You already have an active ${verificationType} verification request (status: ${existing[0].status}).`,
    };
  }

  const { data, error } = await supabase
    .from('verification_requests')
    .insert({
      id: uuid(),
      user_id: userId,
      verification_type: verificationType,
      property_id: propertyId,
      status: 'pending',
      evidence_summary: [],
      appeal_count: 0,
    })
    .select()
    .single();

  if (error || !data) {
    return { success: false, error: `Failed to create verification request: ${error?.message}` };
  }

  await auditLogger.log({
    actorId: userId,
    action: 'verification.submit',
    resourceType: 'user',
    resourceId: data.id,
    ip,
    meta: { verification_type: verificationType, property_id: propertyId },
  });

  return { success: true, data: data as VerificationRequest };
}

/**
 * Upload evidence metadata for a verification request.
 *
 * The actual file is uploaded to Supabase Storage by the controller.
 * This function records the metadata and links it to the request.
 */
export async function addEvidence(
  requestId: string,
  userId: string,
  evidenceType: EvidenceType,
  storagePath: string,
  mimeType: string,
  fileSizeBytes: number,
  ip?: string,
): Promise<ServiceResponse<{ evidenceId: string }>> {
  // Verify the request belongs to the user
  const { data: request } = await supabase
    .from('verification_requests')
    .select('id, user_id, status')
    .eq('id', requestId)
    .single();

  if (!request || request.user_id !== userId) {
    return { success: false, error: 'Verification request not found or not owned by you.' };
  }

  if (!['pending', 'resubmitted', 'under_review'].includes(request.status)) {
    return { success: false, error: `Cannot add evidence to a request in status: ${request.status}` };
  }

  const evidenceId = uuid();
  const retentionUntil = computeRetentionDeadline();

  const { error } = await supabase.from('verification_evidence').insert({
    id: evidenceId,
    verification_request_id: requestId,
    user_id: userId,
    evidence_type: evidenceType,
    storage_path: storagePath,
    mime_type: mimeType,
    file_size_bytes: fileSizeBytes,
    retention_until: retentionUntil,
  });

  if (error) {
    return { success: false, error: `Failed to record evidence: ${error.message}` };
  }

  // Update the evidence_summary on the request
  const summary = [
    ...(request.evidence_summary ?? []),
    { type: evidenceType, uploaded_at: new Date().toISOString() },
  ];

  await supabase
    .from('verification_requests')
    .update({ evidence_summary: summary, updated_at: new Date().toISOString() })
    .eq('id', requestId);

  return { success: true, data: { evidenceId } };
}

/**
 * Get a user's verification requests.
 */
export async function getUserVerifications(
  userId: string,
): Promise<ServiceResponse<VerificationRequest[]>> {
  const { data, error } = await supabase
    .from('verification_requests')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data: (data ?? []) as VerificationRequest[] };
}

/**
 * Get a single verification request (user-facing, own requests only).
 */
export async function getVerificationRequest(
  requestId: string,
  userId: string,
): Promise<ServiceResponse<VerificationRequest>> {
  const { data, error } = await supabase
    .from('verification_requests')
    .select('*')
    .eq('id', requestId)
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    return { success: false, error: 'Verification request not found.' };
  }

  return { success: true, data: data as VerificationRequest };
}

/**
 * Withdraw a verification request (user-initiated).
 * Only allowed when status is pending, under_review, or resubmitted.
 */
export async function withdrawVerificationRequest(
  requestId: string,
  userId: string,
  ip?: string,
): Promise<ServiceResponse<VerificationRequest>> {
  const { data: request, error } = await supabase
    .from('verification_requests')
    .select('*')
    .eq('id', requestId)
    .eq('user_id', userId)
    .single();

  if (error || !request) {
    return { success: false, error: 'Verification request not found.' };
  }

  if (!['pending', 'under_review', 'resubmitted'].includes(request.status)) {
    return { success: false, error: `Cannot withdraw a request in status: ${request.status}` };
  }

  const { data: updated, error: updateError } = await supabase
    .from('verification_requests')
    .update({ status: 'withdrawn', updated_at: new Date().toISOString() })
    .eq('id', requestId)
    .select()
    .single();

  if (updateError) {
    return { success: false, error: updateError.message };
  }

  await auditLogger.log({
    actorId: userId,
    action: 'verification.withdraw',
    resourceType: 'user',
    resourceId: requestId,
    ip,
    meta: { previous_status: request.status },
  });

  return { success: true, data: updated as VerificationRequest };
}

/**
 * Appeal a rejected verification (resubmit).
 * Moves the request back to 'resubmitted' so the user can add new evidence.
 */
export async function appealVerificationRequest(
  requestId: string,
  userId: string,
  ip?: string,
): Promise<ServiceResponse<VerificationRequest>> {
  const { data: request, error } = await supabase
    .from('verification_requests')
    .select('*')
    .eq('id', requestId)
    .eq('user_id', userId)
    .single();

  if (error || !request) {
    return { success: false, error: 'Verification request not found.' };
  }

  if (request.status !== 'rejected') {
    return { success: false, error: 'Only rejected requests can be appealed.' };
  }

  if (request.appeal_count >= MAX_APPEALS) {
    return {
      success: false,
      error: `Maximum appeal attempts (${MAX_APPEALS}) reached. Please contact support.`,
    };
  }

  const { data: updated, error: updateError } = await supabase
    .from('verification_requests')
    .update({
      status: 'resubmitted',
      appeal_count: request.appeal_count + 1,
      last_appealed_at: new Date().toISOString(),
      rejection_reason: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', requestId)
    .select()
    .single();

  if (updateError) {
    return { success: false, error: updateError.message };
  }

  await auditLogger.log({
    actorId: userId,
    action: 'verification.resubmit',
    resourceType: 'user',
    resourceId: requestId,
    ip,
    meta: { appeal_count: request.appeal_count + 1 },
  });

  return { success: true, data: updated as VerificationRequest };
}

// ─── Public badge queries ─────────────────────────────────────────────────────

/**
 * Get active verification badges for a user (public-facing).
 * Returns only badge_type, verified_at, and expires_at — no PII.
 */
export async function getUserBadges(
  userId: string,
): Promise<ServiceResponse<VerificationBadge[]>> {
  const { data, error } = await supabase
    .from('verification_badges')
    .select('id, user_id, property_id, badge_type, verified_at, expires_at, is_active')
    .eq('user_id', userId)
    .eq('is_active', true)
    .order('verified_at', { ascending: false });

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data: (data ?? []) as VerificationBadge[] };
}

/**
 * Get active verification badges for a property's host (public-facing).
 */
export async function getPropertyHostBadges(
  propertyId: string,
): Promise<ServiceResponse<VerificationBadge[]>> {
  const { data: property } = await supabase
    .from('properties')
    .select('owner_id')
    .eq('id', propertyId)
    .single();

  if (!property) {
    return { success: false, error: 'Property not found.' };
  }

  return getUserBadges(property.owner_id);
}

// ─── Admin / moderator operations ──────────────────────────────────────────────

/**
 * List verification requests for moderator review.
 * Supports filtering by status and type.
 */
export async function listVerificationRequestsForReview(
  status?: VerificationStatus,
  verificationType?: VerificationType,
): Promise<ServiceResponse<VerificationRequest[]>> {
  let query = supabase.from('verification_requests').select('*');

  if (status) {
    query = query.eq('status', status);
  }
  if (verificationType) {
    query = query.eq('verification_type', verificationType);
  }

  const { data, error } = await query.order('submitted_at', { ascending: true });

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true, data: (data ?? []) as VerificationRequest[] };
}

/**
 * Get a verification request for moderator review (admin-facing).
 * Includes evidence references.
 */
export async function getVerificationRequestForReview(
  requestId: string,
): Promise<ServiceResponse<{
  request: VerificationRequest;
  evidence: Array<{
    id: string;
    evidence_type: EvidenceType;
    storage_path: string;
    mime_type: string | null;
    uploaded_at: string;
    retention_until: string;
  }>;
}>> {
  const { data: request, error } = await supabase
    .from('verification_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (error || !request) {
    return { success: false, error: 'Verification request not found.' };
  }

  const { data: evidence } = await supabase
    .from('verification_evidence')
    .select('id, evidence_type, storage_path, mime_type, uploaded_at, retention_until')
    .eq('verification_request_id', requestId)
    .order('uploaded_at', { ascending: true });

  return {
    success: true,
    data: {
      request: request as VerificationRequest,
      evidence: (evidence ?? []) as Array<{
        id: string;
        evidence_type: EvidenceType;
        storage_path: string;
        mime_type: string | null;
        uploaded_at: string;
        retention_until: string;
      }>,
    },
  };
}

/**
 * Review a verification request (moderator/admin only).
 *
 * This is the ONLY function that can move status to approved or rejected.
 * The user cannot self-assign these statuses — enforced by RLS and this
 * service layer.
 */
export async function reviewVerificationRequest(
  requestId: string,
  reviewerId: string,
  decision: ReviewDecision,
  notes: string | null,
  ip?: string,
): Promise<ServiceResponse<VerificationRequest>> {
  const { data: request, error } = await supabase
    .from('verification_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (error || !request) {
    return { success: false, error: 'Verification request not found.' };
  }

  // Only pending, under_review, or resubmitted requests can be reviewed
  if (!['pending', 'under_review', 'resubmitted'].includes(request.status)) {
    return {
      success: false,
      error: `Cannot review a request in status: ${request.status}`,
    };
  }

  // Map decision to new status
  const newStatus: VerificationStatus =
    decision === 'approved' ? 'approved' :
    decision === 'rejected' ? 'rejected' :
    decision === 'needs_more_info' ? 'pending' :
    decision === 'expired' ? 'expired' :
    'disputed';

  const now = new Date().toISOString();

  const updateData: Record<string, unknown> = {
    status: newStatus,
    reviewer_id: reviewerId,
    review_notes: notes,
    reviewed_at: now,
    updated_at: now,
  };

  if (decision === 'rejected') {
    updateData.rejection_reason = notes;
  }

  const { data: updated, error: updateError } = await supabase
    .from('verification_requests')
    .update(updateData)
    .eq('id', requestId)
    .select()
    .single();

  if (updateError) {
    return { success: false, error: updateError.message };
  }

  // Log the review
  const auditAction =
    decision === 'approved' ? 'verification.review_approved' :
    decision === 'rejected' ? 'verification.review_rejected' :
    decision === 'needs_more_info' ? 'verification.review_needs_info' :
    decision === 'expired' ? 'verification.expired' :
    'verification.disputed';

  await auditLogger.log({
    actorId: reviewerId,
    action: auditAction,
    resourceType: 'user',
    resourceId: requestId,
    ip,
    meta: {
      from_status: request.status,
      to_status: newStatus,
      decision,
      notes,
    },
  });

  // Write an immutable review log entry
  await supabase.from('verification_reviews').insert({
    id: uuid(),
    verification_request_id: requestId,
    reviewer_id: reviewerId,
    decision,
    notes,
    from_status: request.status,
    to_status: newStatus,
  });

  // If approved, grant the badge
  if (decision === 'approved') {
    const badgeType = request.verification_type === 'identity'
      ? 'identity_verified'
      : 'listing_verified';

    // Deactivate any existing badge of the same type for this user
    await supabase
      .from('verification_badges')
      .update({ is_active: false, updated_at: now })
      .eq('user_id', request.user_id)
      .eq('badge_type', badgeType)
      .eq('is_active', true);

    // Grant the new badge
    await supabase.from('verification_badges').insert({
      id: uuid(),
      user_id: request.user_id,
      property_id: request.property_id,
      badge_type: badgeType,
      verified_at: now,
      expires_at: computeBadgeExpiry(),
      is_active: true,
      verification_request_id: requestId,
    });

    await auditLogger.log({
      actorId: reviewerId,
      action: 'verification.badge_granted',
      resourceType: 'user',
      resourceId: request.user_id,
      ip,
      meta: { badge_type: badgeType, verification_request_id: requestId },
    });
  }

  return { success: true, data: updated as VerificationRequest };
}

/**
 * Revoke a verification badge (admin/moderator only).
 */
export async function revokeBadge(
  badgeId: string,
  reviewerId: string,
  reason: string,
  ip?: string,
): Promise<ServiceResponse<void>> {
  const { error } = await supabase
    .from('verification_badges')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', badgeId)
    .eq('is_active', true);

  if (error) {
    return { success: false, error: error.message };
  }

  await auditLogger.log({
    actorId: reviewerId,
    action: 'verification.badge_revoked',
    resourceType: 'user',
    resourceId: badgeId,
    ip,
    meta: { reason },
  });

  return { success: true };
}

/**
 * Check if a user has an active identity verification badge.
 * Used by search and booking policy to surface verified hosts.
 */
export async function hasActiveBadge(
  userId: string,
  badgeType: 'identity_verified' | 'listing_verified',
): Promise<boolean> {
  const { data } = await supabase
    .from('verification_badges')
    .select('id')
    .eq('user_id', userId)
    .eq('badge_type', badgeType)
    .eq('is_active', true)
    .gt('expires_at', new Date().toISOString())
    .limit(1);

  return (data?.length ?? 0) > 0;
}
