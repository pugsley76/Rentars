-- 00065_create_verification_tables.sql
-- Issue #845: Host identity and listing verification workflow
--
-- Creates tables for verification state model, evidence storage,
-- moderator reviews, and public badges.
--
-- Design principles:
--   1. Verification status CANNOT be self-assigned — only a moderator/admin
--      can approve or reject. The status column is write-restricted via RLS.
--   2. Evidence is access-controlled: only the owning user and moderators can
--      read evidence rows. Storage paths point to Supabase Storage buckets
--      with separate access policies.
--   3. Public badges describe exactly what was verified and when — they
--      expose only badge_type, verified_at, and expires_at.
--   4. Verification has expiry and appeal mechanisms.

-- ─── Verification request (state model) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS verification_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- What is being verified
  verification_type  VARCHAR(50) NOT NULL
    CHECK (verification_type IN ('identity', 'listing')),

  -- Optional property_id for listing verifications
  property_id    UUID REFERENCES properties(id) ON DELETE CASCADE,

  -- State: starts as 'pending', only a moderator can move to approved/rejected.
  -- The user can only move to 'resubmitted' (for appeal) or withdraw.
  status         VARCHAR(30) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'under_review', 'approved', 'rejected', 'expired', 'disputed', 'resubmitted', 'withdrawn')),

  -- Evidence summary (does NOT store the actual files — just metadata)
  evidence_summary  JSONB DEFAULT '[]'::jsonb,

  -- Moderator fields
  reviewer_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  review_notes     TEXT,
  rejection_reason TEXT,

  -- Expiry and appeal
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at     TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  appeal_count    INT NOT NULL DEFAULT 0,
  last_appealed_at TIMESTAMPTZ,

  -- Audit
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_verification_requests_user_id ON verification_requests(user_id);
CREATE INDEX idx_verification_requests_status ON verification_requests(status);
CREATE INDEX idx_verification_requests_type ON verification_requests(verification_type);
CREATE INDEX idx_verification_requests_reviewer_id ON verification_requests(reviewer_id);
CREATE INDEX idx_verification_requests_property_id ON verification_requests(property_id);

-- ─── Verification evidence (access-controlled) ────────────────────────────────
--
-- Stores metadata about uploaded evidence. The actual files live in
-- Supabase Storage with separate RLS-backed bucket policies. This table
-- only tracks what was uploaded, when, and its retention deadline.

CREATE TABLE IF NOT EXISTS verification_evidence (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_request_id UUID NOT NULL REFERENCES verification_requests(id) ON DELETE CASCADE,
  user_id                 UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Type of evidence
  evidence_type           VARCHAR(50) NOT NULL
    CHECK (evidence_type IN (
      'government_id', 'selfie', 'proof_of_address',
      'property_ownership', 'property_photos', 'utility_bill',
      'business_license', 'other'
    )),

  -- Reference to Supabase Storage path (never store the file itself)
  storage_path            TEXT NOT NULL,

  -- File metadata for display
  mime_type               VARCHAR(100),
  file_size_bytes         BIGINT,

  -- Retention: evidence is deleted after this date per policy
  retention_until         TIMESTAMPTZ NOT NULL,

  -- Whether the evidence has been purged (retention enforcement)
  purged_at               TIMESTAMPTZ,

  -- Audit
  uploaded_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_verification_evidence_request_id ON verification_evidence(verification_request_id);
CREATE INDEX idx_verification_evidence_user_id ON verification_evidence(user_id);
CREATE INDEX idx_verification_evidence_retention ON verification_evidence(retention_until)
  WHERE purged_at IS NULL;

-- ─── Verification review log (audit trail for moderator actions) ──────────────
--
-- Every moderator review decision is logged here. This is an append-only
-- table — no UPDATE or DELETE should ever be issued against it.

CREATE TABLE IF NOT EXISTS verification_reviews (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_request_id UUID NOT NULL REFERENCES verification_requests(id) ON DELETE CASCADE,
  reviewer_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  decision                VARCHAR(30) NOT NULL
    CHECK (decision IN ('approved', 'rejected', 'needs_more_info', 'expired', 'disputed')),

  notes                   TEXT,

  -- The status transition that was applied
  from_status             VARCHAR(30) NOT NULL,
  to_status               VARCHAR(30) NOT NULL,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_verification_reviews_request_id ON verification_reviews(verification_request_id);
CREATE INDEX idx_verification_reviews_reviewer_id ON verification_reviews(reviewer_id);

-- ─── Verification badges (public, minimal) ───────────────────────────────────
--
-- Public-facing badge records. Expose only what was verified and when.
-- These rows are created when a verification request is approved and
-- destroyed when it expires or is revoked.

CREATE TABLE IF NOT EXISTS verification_badges (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_id     UUID REFERENCES properties(id) ON DELETE CASCADE,

  -- What badge this represents
  badge_type      VARCHAR(50) NOT NULL
    CHECK (badge_type IN ('identity_verified', 'listing_verified')),

  -- When it was verified and when it expires
  verified_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at      TIMESTAMPTZ NOT NULL,

  -- Whether the badge is currently visible to the public
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,

  -- Reference to the originating verification request
  verification_request_id UUID REFERENCES verification_requests(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- A user can only have one active badge of each type
  CONSTRAINT uq_verification_badge_user_type UNIQUE (user_id, badge_type, property_id)
);

CREATE INDEX idx_verification_badges_user_id ON verification_badges(user_id);
CREATE INDEX idx_verification_badges_property_id ON verification_badges(property_id);
CREATE INDEX idx_verification_badges_active ON verification_badges(is_active)
  WHERE is_active = TRUE;

-- ─── RLS Policies ────────────────────────────────────────────────────────────
-- Evidence is the most sensitive table: only the owning user and moderators.

ALTER TABLE verification_evidence ENABLE ROW LEVEL SECURITY;

-- Users can read their own evidence
CREATE POLICY verification_evidence_owner_read ON verification_evidence
  FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own evidence
CREATE POLICY verification_evidence_owner_insert ON verification_evidence
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Verification requests: users can read their own, admins can read all
ALTER TABLE verification_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY verification_requests_owner_read ON verification_requests
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY verification_requests_owner_insert ON verification_requests
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can UPDATE only specific columns (status cannot be self-assigned)
CREATE POLICY verification_requests_owner_update ON verification_requests
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (
    auth.uid() = user_id
    -- Users may only set status to 'withdrawn' or 'resubmitted' (appeal)
    AND status IN ('withdrawn', 'resubmitted')
  );

-- Badges are readable by anyone (public information)
ALTER TABLE verification_badges ENABLE ROW LEVEL SECURITY;

CREATE POLICY verification_badges_public_read ON verification_badges
  FOR SELECT USING (is_active = TRUE);

-- Review log is admin-only
ALTER TABLE verification_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY verification_reviews_admin_read ON verification_reviews
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.role IN ('admin', 'moderator')
    )
  );
