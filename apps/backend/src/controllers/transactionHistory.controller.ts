/**
 * Transaction History controller — exposes the wallet transaction timeline
 * for a booking.
 *
 * GET /api/v1/bookings/:bookingId/transactions
 *
 * Returns a user-scoped transaction timeline with network, confirmation
 * state, amount, related booking, and explorer link.
 * Excludes all signing secrets and private key material.
 */

import type { Response } from 'express';
import type { AuthRequest } from '@/middleware/auth.middleware.js';
import { getBookingTransactionHistory } from '@/services/transactionHistory.service.js';

/**
 * GET /api/v1/bookings/:bookingId/transactions
 *
 * Returns the transaction lifecycle for the authenticated user's booking.
 * Only the tenant or host of the booking may access this endpoint.
 */
export async function getTransactionHistory(
  req: AuthRequest,
  res: Response,
): Promise<void> {
  const { bookingId } = req.params;

  if (!bookingId) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'bookingId is required' } });
    return;
  }

  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    return;
  }

  const result = await getBookingTransactionHistory(bookingId, userId, req.user?.role);

  if (!result.success || !result.data) {
    // Distinguish 403 (forbidden) from 404 (not found) based on error message
    if (result.error?.includes('Forbidden')) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: result.error } });
      return;
    }
    res.status(404).json({ error: { code: 'NOT_FOUND', message: result.error ?? 'Transaction history not found' } });
    return;
  }

  res.json(result.data);
}
