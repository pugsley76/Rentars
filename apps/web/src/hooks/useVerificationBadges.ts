'use client';

/**
 * useVerificationBadges — fetches public verification badges for a user or property.
 *
 * Per Issue #845: badges are public — they describe exactly what was verified
 * and when. No authentication is required to read badges.
 */

import { useCallback, useEffect, useState } from 'react';
import type { VerificationBadge } from '@/types/verification';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export function useVerificationBadgesByUser(userId: string | null) {
  return useBadges(userId ? `badges/user/${userId}` : null);
}

export function useVerificationBadgesByProperty(propertyId: string | null) {
  return useBadges(propertyId ? `badges/property/${propertyId}` : null);
}

function useBadges(path: string | null) {
  const [badges, setBadges] = useState<VerificationBadge[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBadges = useCallback(async () => {
    if (!path) {
      setBadges([]);
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch(`${API_URL}/api/v1/verification/${path}`);
      if (!res.ok) {
        setError('Failed to load verification badges.');
        setBadges([]);
        return;
      }
      const data: VerificationBadge[] = await res.json();
      setBadges(data);
      setError(null);
    } catch {
      setError('Network error — could not reach the server.');
      setBadges([]);
    } finally {
      setIsLoading(false);
    }
  }, [path]);

  useEffect(() => {
    fetchBadges();
  }, [fetchBadges]);

  return { badges, isLoading, error, refetch: fetchBadges };
}
