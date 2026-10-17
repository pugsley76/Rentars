/**
 * Verification types — mirrors the backend response from
 * GET /api/v1/verification/badges/... (Issue #845).
 */

export type VerificationBadgeType = 'identity_verified' | 'listing_verified';

export interface VerificationBadge {
  id: string;
  user_id: string;
  property_id: string | null;
  badge_type: VerificationBadgeType;
  verified_at: string;
  expires_at: string;
  is_active: boolean;
}

export type VerificationStatus =
  | 'pending'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'disputed'
  | 'resubmitted'
  | 'withdrawn';

export type VerificationType = 'identity' | 'listing';

export interface VerificationRequest {
  id: string;
  user_id: string;
  verification_type: VerificationType;
  property_id: string | null;
  status: VerificationStatus;
  evidence_summary: Array<{ type: string; uploaded_at: string }>;
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

/** Human-readable labels for badge types. */
export const BADGE_LABELS: Record<VerificationBadgeType, string> = {
  identity_verified: 'Identity Verified',
  listing_verified: 'Listing Verified',
};

/** Description text for each badge type — describes exactly what was verified. */
export const BADGE_DESCRIPTIONS: Record<VerificationBadgeType, string> = {
  identity_verified: 'This host has submitted government-issued ID and selfie verification, reviewed and approved by a Rentars moderator.',
  listing_verified: 'This listing has been verified with proof of ownership and property documentation, reviewed and approved by a Rentars moderator.',
};

/** Status labels for verification requests. */
export const STATUS_LABELS: Record<VerificationStatus, string> = {
  pending: 'Pending Review',
  under_review: 'Under Review',
  approved: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
  disputed: 'Disputed',
  resubmitted: 'Awaiting Resubmission',
  withdrawn: 'Withdrawn',
};
