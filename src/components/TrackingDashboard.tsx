import React, { useEffect, useState } from 'react';
import { getEvents, trackEvent } from '../lib/api';
import type { OutreachEvent, OutreachStatus } from '../lib/types';
import Avatar from './Avatar';
import { SkeletonBar } from './Skeleton';
import WarningBanner from './WarningBanner';
import { PopupHeader, SectionLabel, StatusDot, textButtonClass } from './ui';

interface TrackingDashboardProps {
  token: string;
  onBack: () => void;
}

const STATUS_STYLE: Record<OutreachStatus, { tone: 'neutral' | 'success' | 'warning'; className: string }> = {
  drafted: { tone: 'neutral', className: 'text-gray-600' },
  sent: { tone: 'warning', className: 'text-warning-700' },
  replied: { tone: 'success', className: 'text-success-700' },
  bounced: { tone: 'neutral', className: 'text-danger-700' },
};

function formatDate(iso?: string): string {
  if (!iso) return 'Not sent';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return 'Unknown date';
  }
}

export default function TrackingDashboard({ token, onBack }: TrackingDashboardProps) {
  const [events, setEvents] = useState<OutreachEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);

  const loadEvents = () => {
    setLoading(true);
    getEvents(token)
      .then(setEvents)
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load outreach.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadEvents();
  }, [token]);

  const handleUpdateStatus = async (event: OutreachEvent, outcome: 'replied' | 'bounced') => {
    setUpdating(event.id);
    try {
      await trackEvent(token, {
        contact_id: event.contact.id,
        channel: event.channel,
        outcome,
      });
      setEvents((current) =>
        current.map((item) => (item.id === event.id ? { ...item, status: outcome } : item)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the status.');
    } finally {
      setUpdating(null);
    }
  };

  return (
    <div className="flex min-h-full animate-slide-in-right flex-col bg-white">
      <PopupHeader title="Outreach" subtitle="Drafts, sends, and replies" onBack={onBack} />

      <main className="flex flex-1 flex-col px-4 py-4">
        {loading ? (
          <div className="flex flex-col gap-3" role="status" aria-live="polite">
            <p className="text-sm text-gray-600">Loading outreach…</p>
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="flex min-h-16 items-center gap-3 border-b border-gray-200 py-2">
                <div className="skeleton animate-shimmer h-9 w-9 flex-shrink-0 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <SkeletonBar width="50%" height={10} />
                  <SkeletonBar width="35%" height={9} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col">
            {error && <WarningBanner message={error} variant="error" />}

            {events.length === 0 ? (
              <div className="flex flex-1 flex-col items-start justify-center gap-3 py-12">
                <SectionLabel>No outreach yet</SectionLabel>
                <h1 className="text-xl font-semibold text-gray-950">Your drafts will appear here</h1>
                <p className="text-sm leading-5 text-gray-600">Find a contact, write a draft, then track the reply.</p>
                <button type="button" onClick={onBack} className={textButtonClass}>Find contacts</button>
              </div>
            ) : (
              <section aria-labelledby="outreach-history-heading">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <div id="outreach-history-heading"><SectionLabel>History</SectionLabel></div>
                  <span className="text-xs tabular-nums text-gray-600">{events.length} total</span>
                </div>
                <div className="divide-y divide-gray-200 border-y border-gray-200">
                  {events.map((event) => {
                    const statusStyle = STATUS_STYLE[event.status];
                    return (
                      <article key={event.id} className="flex flex-col gap-2 py-3">
                        <div className="flex items-start gap-3">
                          <Avatar name={event.contact.full_name} size={36} />
                          <div className="min-w-0 flex-1">
                            <h2 className="truncate text-sm font-semibold text-gray-950">{event.contact.full_name}</h2>
                            <p className="truncate text-xs text-gray-600">{event.contact.company_domain}</p>
                            {event.subject && <p className="mt-1 truncate text-xs text-gray-600">{event.subject}</p>}
                          </div>
                          <div className="flex flex-shrink-0 flex-col items-end gap-1">
                            <span className={`inline-flex items-center gap-1.5 text-xs font-medium capitalize ${statusStyle.className}`}>
                              <StatusDot tone={statusStyle.tone} />
                              {event.status}
                            </span>
                            <time className="text-xs tabular-nums text-gray-600">{formatDate(event.sent_at)}</time>
                          </div>
                        </div>

                        {(event.status === 'sent' || event.status === 'drafted') && (
                          <div className="flex items-center justify-end gap-1 pl-12">
                            <button
                              type="button"
                              onClick={() => handleUpdateStatus(event, 'replied')}
                              disabled={updating === event.id}
                              className={textButtonClass}
                            >
                              Mark replied
                            </button>
                            <button
                              type="button"
                              onClick={() => handleUpdateStatus(event, 'bounced')}
                              disabled={updating === event.id}
                              className={`${textButtonClass} text-danger-700 hover:bg-danger-50 hover:text-danger-700`}
                            >
                              Mark bounced
                            </button>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
