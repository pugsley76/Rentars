'use client';

/**
 * VerificationBadges — displays public verification badges for a host or property.
 *
 * Per Issue #845 acceptance criteria:
 *   - Public badges describe exactly what was verified and when.
 *   - Badges show the badge type (identity_verified, listing_verified),
 *     the date verified, and expiry date.
 *   - No PII or evidence details are exposed — only what was verified.
 *
 * Accessibility:
 *   - Uses semantic role="group" with aria-label.
 *   - Each badge has a tooltip (title attr) with the verification description.
 *   - Status icons have aria-hidden for decorative purposes.
 */

import { ShieldCheck, BadgeCheck, Loader2, Info } from 'lucide-react';
import {
  useVerificationBadgesByUser,
  useVerificationBadgesByProperty,
} from '@/hooks/useVerificationBadges';
import {
  type VerificationBadge,
  type VerificationBadgeType,
  BADGE_LABELS,
  BADGE_DESCRIPTIONS,
} from '@/types/verification';

interface VerificationBadgesProps {
  /** Fetch badges by user ID (host). */
  userId?: string | null;
  /** Fetch badges by property ID (resolves to the host's badges). */
  propertyId?: string | null;
  /** Compact mode: smaller badges without dates, for inline display. */
  compact?: boolean;
}

/** Icon for each badge type. */
function BadgeIcon({ type, size = 18 }: { type: VerificationBadgeType; size?: number }) {
  if (type === 'identity_verified') {
    return <BadgeCheck size={size} className="text-green-600" aria-hidden="true" />;
  }
  return <ShieldCheck size={size} className="text-blue-600" aria-hidden="true" />;
}

/** Format an ISO date to a short display string. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Check if a badge has expired. */
function isExpired(badge: VerificationBadge): boolean {
  return new Date(badge.expires_at) < new Date();
}

/** A single badge pill. */
function BadgePill({
  badge,
  compact,
}: {
  badge: VerificationBadge;
  compact: boolean;
}) {
  const expired = isExpired(badge);

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
          expired
            ? 'bg-gray-100 text-gray-400'
            : badge.badge_type === 'identity_verified'
              ? 'bg-green-50 text-green-700'
              : 'bg-blue-50 text-blue-700'
        }`}
        title={BADGE_DESCRIPTIONS[badge.badge_type]}
      >
        <BadgeIcon type={badge.badge_type} size={14} />
        {BADGE_LABELS[badge.badge_type]}
      </span>
    );
  }

  return (
    <div
      className={`flex items-start gap-3 p-3 rounded-lg border ${
        expired
          ? 'bg-gray-50 border-gray-200'
          : badge.badge_type === 'identity_verified'
            ? 'bg-green-50 border-green-200'
            : 'bg-blue-50 border-blue-200'
      }`}
      title={BADGE_DESCRIPTIONS[badge.badge_type]}
    >
      <div className="flex-shrink-0 pt-0.5">
        <BadgeIcon type={badge.badge_type} size={22} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900">
          {BADGE_LABELS[badge.badge_type]}
          {expired && (
            <span className="ml-2 text-xs font-normal text-gray-400">(expired)</span>
          )}
        </p>
        <p className="text-xs text-gray-500 mt-0.5">
          Verified on {formatDate(badge.verified_at)}
        </p>
        <p className="text-xs text-gray-400">
          Valid until {formatDate(badge.expires_at)}
        </p>
      </div>
      <Info
        size={14}
        className="text-gray-400 flex-shrink-0 mt-1"
        aria-hidden="true"
      />
    </div>
  );
}

export default function VerificationBadges({
  userId,
  propertyId,
  compact = false,
}: VerificationBadgesProps) {
  const userBadges = useVerificationBadgesByUser(userId ?? null);
  const propBadges = useVerificationBadgesByProperty(propertyId ?? null);

  // Use whichever query is active
  const badges = userId ? userBadges.badges : propBadges.badges;
  const isLoading = userId ? userBadges.isLoading : propBadges.isLoading;
  const error = userId ? userBadges.error : propBadges.error;

  if (isLoading) {
    return (
      <div
        className="flex items-center gap-2 text-sm text-gray-400"
        role="status"
        aria-live="polite"
      >
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
        <span>Checking verification status…</span>
      </div>
    );
  }

  if (error) {
    // Silently fail — badges are a nice-to-have, not critical for rendering
    return null;
  }

  if (badges.length === 0) {
    if (compact) return null;
    return (
      <p className="text-sm text-gray-400" role="note">
        This host has not completed verification.
      </p>
    );
  }

  return (
    <div
      role="group"
      aria-label="Host verification badges"
      className={compact ? 'flex flex-wrap gap-2' : 'space-y-2'}
    >
      {badges.map((badge) => (
        <BadgePill key={badge.id} badge={badge} compact={compact} />
      ))}
    </div>
  );
}
