-- 00066_create_analytics_consent.sql
-- Issue #846: Add accessibility and privacy controls for analytics consent
--
-- Creates a granular analytics consent table that distinguishes:
--   - Required operational logs (security, transaction records) — cannot be opted out
--   - Optional analytics (product events, search analytics, performance) — can be revoked
--
-- The existing `user_analytics_preferences` table (simple opt-out boolean) is
-- retained for backwards compatibility. This new table adds per-category
-- granularity, revocation timestamps, and audit trail.

CREATE TABLE IF NOT EXISTS analytics_consent (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Consent category
  -- required_operations: security logs, transaction records — always true, cannot be revoked
  -- product_analytics: funnel events, listing views — optional, revocable
  -- search_analytics: search queries, zero-result tracking — optional, revocable
  -- performance: page load timing, error reporting — optional, revocable
  consent_category  VARCHAR(30) NOT NULL
    CHECK (consent_category IN (
      'required_operations',
      'product_analytics',
      'search_analytics',
      'performance'
    )),

  -- Whether consent is currently granted
  consent_given     BOOLEAN NOT NULL DEFAULT FALSE,

  -- When consent was first granted
  granted_at        TIMESTAMPTZ,

  -- When consent was revoked (null = still active)
  revoked_at        TIMESTAMPTZ,

  -- IP address of the last change (for audit)
  last_change_ip    VARCHAR(45),

  -- Audit
  created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- A user can have only one consent row per category
  CONSTRAINT uq_analytics_consent_user_category UNIQUE (user_id, consent_category)
);

CREATE INDEX idx_analytics_consent_user_id ON analytics_consent(user_id);
CREATE INDEX idx_analytics_consent_category ON analytics_consent(consent_category);
CREATE INDEX idx_analytics_consent_given ON analytics_consent(consent_given)
  WHERE consent_given = TRUE;

-- ─── RLS: users can read and update their own consent ─────────────────────────
ALTER TABLE analytics_consent ENABLE ROW LEVEL SECURITY;

CREATE POLICY analytics_consent_owner_read ON analytics_consent
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY analytics_consent_owner_upsert ON analytics_consent
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY analytics_consent_owner_update ON analytics_consent
  FOR UPDATE USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── Seed default consent rows for required operations ────────────────────────
-- Required operational consent is always TRUE and cannot be revoked.
-- This row is created automatically for every new user via a trigger.

CREATE OR REPLACE FUNCTION ensure_required_consent()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO analytics_consent (user_id, consent_category, consent_given, granted_at)
  VALUES (NEW.id, 'required_operations', TRUE, CURRENT_TIMESTAMP)
  ON CONFLICT (user_id, consent_category) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ensure_required_consent
  AFTER INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION ensure_required_consent();
