'use client';

/**
 * useTransactionHistory — fetches the wallet transaction timeline for a booking.
 *
 * Polls every 5 seconds while any transaction is in a non-terminal state
 * (pending, submitted, timed_out) so the UI reflects on-chain confirmations
 * without manual refresh. Stops polling once all entries are in terminal
 * states (confirmed, failed, refunded).
 *
 * Per Issue #844: never exposes signing secrets — the backend strips them
 * before returning data.
 */

import { useCallback, useEffect, useState } from 'react';
import type { TransactionHistoryResult, TransactionStatus } from '@/types/transaction';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';
const POLL_INTERVAL_MS = 5_000;

/** States that are not yet final and warrant continued polling. */
const NON_TERMINAL_STATUSES: TransactionStatus[] = ['pending', 'submitted', 'timed_out'];

export function useTransactionHistory(bookingId: string | null) {
  const [data, setData] = useState<TransactionHistoryResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    if (!bookingId) return;

    const token = localStorage.getItem('token');
    try {
      const res = await fetch(`${API_URL}/api/v1/bookings/${bookingId}/transactions`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 403) {
        setError('You do not have access to this booking\'s transaction history.');
        return;
      }
      if (res.status === 404) {
        setError('Booking or transaction history not found.');
        return;
      }
      if (!res.ok) {
        setError('Failed to load transaction history.');
        return;
      }

      const result: TransactionHistoryResult = await res.json();
      setData(result);
      setError(null);
    } catch {
      setError('Network error — could not reach the server.');
    }
  }, [bookingId]);

  useEffect(() => {
    if (!bookingId) {
      setData(null);
      return;
    }

    setIsLoading(true);
    fetchHistory().finally(() => setIsLoading(false));

    // Poll while any transaction is in a non-terminal state
    const interval = setInterval(() => {
      const hasPending =
        data?.transactions.some((tx) =>
          NON_TERMINAL_STATUSES.includes(tx.status),
        ) ?? true; // keep polling if we don't have data yet

      if (!hasPending) {
        clearInterval(interval);
        return;
      }

      fetchHistory();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookingId]);

  return { data, isLoading, error, refetch: fetchHistory };
}
