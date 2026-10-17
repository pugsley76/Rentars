/**
 * Transaction history types — mirrors the backend response from
 * GET /api/v1/bookings/:bookingId/transactions (Issue #844).
 *
 * The UI distinguishes submitted from confirmed and never displays
 * signing secrets.
 */

export type TransactionStatus =
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'refunded'
  | 'pending'
  | 'timed_out';

export type TransactionSource = 'payment' | 'blockchain_log' | 'booking';

export interface TransactionHistoryEntry {
  id: string;
  source: TransactionSource;
  /** Stellar transaction hash (may be null for pending entries). */
  txHash: string | null;
  /** TrustlessWork escrow contract ID, if available. */
  escrowId: string | null;
  /** Normalised status for the UI. */
  status: TransactionStatus;
  /** Amount in USDC stroops (1 USDC = 10_000_000). Null when not a payment. */
  amountStroops: string | null;
  /** Currency label, always "USDC" for payment entries. */
  currency: string | null;
  /** Stellar network: "testnet" or "mainnet". */
  network: string;
  /** Block explorer URL for the tx hash, or null when no hash. */
  explorerUrl: string | null;
  /** Human-readable description of the event. */
  description: string;
  /** Log type for blockchain_log entries (reconciliation, error, success). */
  logType: string | null;
  /** ISO timestamp of when the event occurred. */
  timestamp: string;
}

export interface TransactionHistoryResult {
  bookingId: string;
  network: string;
  transactions: TransactionHistoryEntry[];
}

/**
 * Convert stroops to a USDC display string.
 * 10_000_000 stroops = 1 USDC
 */
export function stroopsToUsdc(stroops: string | null): string | null {
  if (!stroops) return null;
  const value = Number(stroops) / 10_000_000;
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 7,
  });
}

/**
 * Human-readable label for each transaction status.
 */
export const STATUS_LABELS: Record<TransactionStatus, string> = {
  submitted: 'Submitted to Network',
  confirmed: 'Confirmed on Ledger',
  failed: 'Failed',
  refunded: 'Refunded',
  pending: 'Pending',
  timed_out: 'Timed Out — Retry Available',
};

/**
 * Tailwind colour classes for each status badge.
 */
export const STATUS_COLOURS: Record<TransactionStatus, string> = {
  submitted: 'bg-blue-100 text-blue-700 border-blue-200',
  confirmed: 'bg-green-100 text-green-700 border-green-200',
  failed: 'bg-red-100 text-red-700 border-red-200',
  refunded: 'bg-purple-100 text-purple-700 border-purple-200',
  pending: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  timed_out: 'bg-orange-100 text-orange-700 border-orange-200',
};
