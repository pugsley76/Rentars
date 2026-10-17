'use client';

/**
 * TransactionTimeline — displays the wallet transaction lifecycle for a booking.
 *
 * Per Issue #844 acceptance criteria:
 *  - Participants can see the transaction lifecycle and network for their booking.
 *  - The UI distinguishes submitted from confirmed.
 *  - Never displays signing secrets (the backend strips them before returning).
 *  - Each entry links to the Stellar block explorer when a tx hash is available.
 *
 * Accessibility:
 *  - Uses semantic <ol> for the timeline with role="list".
 *  - Status badges have aria-label for screen readers.
 *  - Explorer links open in a new tab with rel="noopener noreferrer".
 */

import { ExternalLink, Loader2, AlertCircle, Clock, CheckCircle, XCircle, RefreshCw } from 'lucide-react';
import { useTransactionHistory } from '@/hooks/useTransactionHistory';
import {
  type TransactionHistoryEntry,
  type TransactionStatus,
  STATUS_LABELS,
  STATUS_COLOURS,
  stroopsToUsdc,
} from '@/types/transaction';

interface TransactionTimelineProps {
  bookingId: string;
}

/** Icon for each transaction status. */
function StatusIcon({ status }: { status: TransactionStatus }) {
  switch (status) {
    case 'confirmed':
      return <CheckCircle className="text-green-600" size={20} aria-hidden="true" />;
    case 'failed':
      return <XCircle className="text-red-600" size={20} aria-hidden="true" />;
    case 'submitted':
      return <Clock className="text-blue-600" size={20} aria-hidden="true" />;
    case 'timed_out':
      return <AlertCircle className="text-orange-600" size={20} aria-hidden="true" />;
    case 'refunded':
      return <RefreshCw className="text-purple-600" size={20} aria-hidden="true" />;
    default:
      return <Clock className="text-yellow-600" size={20} aria-hidden="true" />;
  }
}

/** Format an ISO timestamp into a human-readable date-time string. */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A single timeline entry. */
function TimelineEntry({ entry, isLast }: { entry: TransactionHistoryEntry; isLast: boolean }) {
  const usdcAmount = stroopsToUsdc(entry.amountStroops);

  return (
    <li className="relative pb-6">
      {/* Vertical connector line */}
      {!isLast && (
        <span
          className="absolute left-[10px] top-6 bottom-0 w-px bg-gray-200"
          aria-hidden="true"
        />
      )}

      <div className="flex gap-3">
        {/* Status icon */}
        <div className="flex-shrink-0 pt-0.5">
          <StatusIcon status={entry.status} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${STATUS_COLOURS[entry.status]}`}
              role="status"
              aria-label={`Transaction status: ${STATUS_LABELS[entry.status]}`}
            >
              {STATUS_LABELS[entry.status]}
            </span>
            <span className="text-xs text-gray-500 capitalize">
              {entry.source.replace('_', ' ')}
            </span>
          </div>

          <p className="mt-1 text-sm text-gray-900">{entry.description}</p>

          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
            <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
            {usdcAmount && (
              <span className="font-medium text-gray-700">
                {usdcAmount} {entry.currency}
              </span>
            )}
            <span className="capitalize">{entry.network}</span>
            {entry.escrowId && (
              <span title="Escrow contract ID">
                Escrow: {entry.escrowId.slice(0, 8)}…
              </span>
            )}
          </div>

          {entry.txHash && entry.explorerUrl && (
            <a
              href={entry.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 hover:underline"
            >
              <ExternalLink size={12} aria-hidden="true" />
              View on Stellar Explorer
              <span className="sr-only">— opens in new tab, tx hash {entry.txHash.slice(0, 12)}…</span>
            </a>
          )}
        </div>
      </div>
    </li>
  );
}

export default function TransactionTimeline({ bookingId }: TransactionTimelineProps) {
  const { data, isLoading, error } = useTransactionHistory(bookingId);

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="animate-spin text-gray-400" size={24} aria-hidden="true" />
        <span className="ml-2 text-sm text-gray-500">Loading transaction history…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="rounded-lg border border-red-200 bg-red-50 p-4"
        role="alert"
        aria-live="assertive"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="text-red-600 flex-shrink-0 mt-0.5" size={18} aria-hidden="true" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      </div>
    );
  }

  const transactions = data?.transactions ?? [];

  if (transactions.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <p className="text-sm">No transactions recorded for this booking yet.</p>
      </div>
    );
  }

  return (
    <section
      aria-label="Wallet transaction history"
      className="bg-white rounded-lg shadow-sm border border-gray-100 p-6"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">
          Transaction History
        </h3>
        {data && (
          <span className="text-xs text-gray-500 capitalize">
            {data.network}
          </span>
        )}
      </div>

      <ol className="relative" role="list">
        {transactions.map((entry, index) => (
          <TimelineEntry
            key={entry.id}
            entry={entry}
            isLast={index === transactions.length - 1}
          />
        ))}
      </ol>
    </section>
  );
}
