/**
 * Transaction History Service — aggregates a user-scoped transaction timeline
 * for a booking from multiple on-chain and off-chain sources.
 *
 * Sources (per Issue #844):
 *  - `payments` table (USDC payment intents with Stellar tx hashes)
 *  - `blockchain_logs` table (reconciliation, error, and success events)
 *  - `bookings` table (escrow metadata: escrow_id, escrow_hash, on_chain_id)
 *
 * Authorization:
 *  Only the tenant or host of the booking may access the timeline.
 *  Other users receive 403 — they cannot enumerate transaction history.
 *
 * Privacy:
 *  - Never returns signing secrets, private keys, seeds, or signed XDR.
 *  - Returns only: network, confirmation state, amount, tx hash, explorer
 *    link, and the related booking reference.
 */

import { supabase } from '@/config/supabase.js';
import { bookingAuthorizationService } from './bookingAuthorization.service.js';
import type { ServiceResponse } from './index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Normalised transaction lifecycle status presented to the user. */
export type TransactionStatus =
  | 'submitted'
  | 'confirmed'
  | 'failed'
  | 'refunded'
  | 'pending'
  | 'timed_out';

/** The source table this timeline entry originated from. */
export type TransactionSource = 'payment' | 'blockchain_log' | 'booking';

/** A single entry in the transaction timeline. */
export interface TransactionHistoryEntry {
  id: string;
  source: TransactionSource;
  /** Stellar transaction hash (may be null for pending entries). */
  txHash: string | null;
  /** TrustlessWork escrow contract ID, if available. */
  escrowId: string | null;
  /** Normalised status for the UI. */
  status: TransactionStatus;
  /** Amount in USDC stroops (integer, 1 USDC = 10_000_000). Null when not a payment. */
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

// ─── Constants ────────────────────────────────────────────────────────────────

/** Fields that must never appear in a transaction history response. */
const SENSITIVE_FIELDS = [
  'signed_xdr', 'xdr', 'signedXdr',
  'secret', 'private_key', 'seed', 'mnemonic',
  'signature', 'signing',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Determine the current Stellar network from env.
 */
function getNetwork(): string {
  return process.env.STELLAR_NETWORK ?? 'testnet';
}

/**
 * Build a block explorer URL for a given tx hash and network.
 */
function buildExplorerUrl(txHash: string, network: string): string {
  const base =
    network === 'mainnet'
      ? 'https://stellar.expert/explorer/public/tx/'
      : 'https://stellar.expert/explorer/testnet/tx/';
  return `${base}${txHash}`;
}

/**
 * Map a raw payment status to the normalised TransactionStatus.
 */
function normalizePaymentStatus(raw: string): TransactionStatus {
  const map: Record<string, TransactionStatus> = {
    pending: 'pending',
    submitted: 'submitted',
    confirmed: 'confirmed',
    failed: 'failed',
    timed_out: 'timed_out',
    refunded: 'refunded',
    under_review: 'pending',
  };
  return map[raw] ?? 'pending';
}

/**
 * Map a blockchain_log on_chain_status to a normalised TransactionStatus.
 */
function normalizeBlockchainStatus(
  logType: string,
  onChainStatus: string | null,
): TransactionStatus {
  if (onChainStatus === 'funded' || onChainStatus === 'confirmed') return 'confirmed';
  if (onChainStatus === 'escrow_reconcile_failed') return 'failed';
  if (onChainStatus === 'released' || onChainStatus === 'refunded') return 'refunded';

  if (logType === 'success') return 'confirmed';
  if (logType === 'error') return 'failed';
  if (logType === 'reconciliation') return 'pending';

  return 'pending';
}

/**
 * Strip any sensitive fields from a metadata object.
 * Returns a sanitised copy — never mutates the original.
 */
function sanitizeMetadata(
  meta: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!meta || typeof meta !== 'object') return null;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_FIELDS.some((s) => lower.includes(s))) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

// ─── Core service ─────────────────────────────────────────────────────────────

/**
 * Get the transaction history timeline for a booking.
 *
 * @param bookingId - UUID of the booking
 * @param userId - UUID of the requesting user
 * @param userRole - optional role claim for admin access
 * @returns ServiceResponse with the transaction timeline, or an auth error
 */
export async function getBookingTransactionHistory(
  bookingId: string,
  userId: string,
  userRole?: string,
): Promise<ServiceResponse<TransactionHistoryResult>> {
  // 1. Authorization — only tenant or host (or admin) may view
  const auth = await bookingAuthorizationService.canRead(bookingId, userId, userRole);
  if (!auth.allowed) {
    return { success: false, error: auth.reason ?? 'Forbidden: access denied' };
  }

  const network = getNetwork();

  // 2. Fetch booking metadata (escrow_id, escrow_hash, on_chain_id)
  const { data: booking } = await supabase
    .from('bookings')
    .select('id, escrow_id, escrow_hash, on_chain_id, total_price, status')
    .eq('id', bookingId)
    .single();

  // 3. Fetch all payment records for this booking
  const { data: payments, error: paymentsError } = await supabase
    .from('payments')
    .select('id, booking_id, tenant_id, amount_stroops, amount_usdc, currency, stellar_tx_hash, escrow_id, status, created_at, updated_at, metadata')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: true });

  // 4. Fetch blockchain logs for this booking
  const { data: blockchainLogs, error: logsError } = await supabase
    .from('blockchain_logs')
    .select('id, booking_id, tx_hash, log_type, message, on_chain_status, error_category, attempt, created_at')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: true });

  const entries: TransactionHistoryEntry[] = [];

  // 5. Build timeline from payment records
  for (const payment of payments ?? []) {
    const txHash = payment.stellar_tx_hash;
    const status = normalizePaymentStatus(payment.status);
    const amountStroops = payment.amount_stroops?.toString() ?? payment.amount_usdc?.toString() ?? null;

    entries.push({
      id: payment.id,
      source: 'payment',
      txHash,
      escrowId: payment.escrow_id ?? booking?.escrow_id ?? null,
      status,
      amountStroops,
      currency: payment.currency ?? 'USDC',
      network,
      explorerUrl: txHash ? buildExplorerUrl(txHash, network) : null,
      description: `USDC payment ${status}`,
      logType: null,
      timestamp: payment.created_at,
    });
  }

  // 6. Build timeline from blockchain logs (reconciliation events)
  for (const log of blockchainLogs ?? []) {
    const txHash = log.tx_hash;
    const status = normalizeBlockchainStatus(log.log_type, log.on_chain_status);
    const attemptInfo = log.attempt ? ` (attempt ${log.attempt})` : '';

    entries.push({
      id: log.id,
      source: 'blockchain_log',
      txHash,
      escrowId: booking?.escrow_id ?? null,
      status,
      amountStroops: null,
      currency: null,
      network,
      explorerUrl: txHash ? buildExplorerUrl(txHash, network) : null,
      description: log.message ?? `${log.log_type}${attemptInfo}`,
      logType: log.log_type,
      timestamp: log.created_at,
    });
  }

  // 7. If we have an escrow hash on the booking but no payment entries,
  //    add a booking-level entry so the user sees the escrow reference
  if (booking?.escrow_hash && entries.length === 0) {
    entries.push({
      id: `booking-${booking.id}`,
      source: 'booking',
      txHash: booking.escrow_hash,
      escrowId: booking.escrow_id ?? null,
      status: 'pending',
      amountStroops: null,
      currency: null,
      network,
      explorerUrl: booking.escrow_hash ? buildExplorerUrl(booking.escrow_hash, network) : null,
      description: `Escrow transaction pending confirmation`,
      logType: null,
      timestamp: new Date().toISOString(),
    });
  }

  // 8. Sort chronologically (oldest first)
  entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return {
    success: true,
    data: {
      bookingId,
      network,
      transactions: entries,
    },
  };
}
