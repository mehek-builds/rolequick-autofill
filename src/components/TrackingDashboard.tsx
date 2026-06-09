import React, { useState, useEffect } from 'react';
import { getEvents, trackEvent } from '../lib/api';
import type { OutreachEvent, OutreachStatus } from '../lib/types';
import WarningBanner from './WarningBanner';
import Avatar from './Avatar';
import { SkeletonBar } from './Skeleton';

interface TrackingDashboardProps {
  token: string;
  onBack: () => void;
}

const STATUS_COLORS: Record<OutreachStatus, string> = {
  drafted: 'bg-gray-100 text-gray-600',
  sent: 'bg-amber-50 text-amber-700',
  replied: 'bg-green-50 text-green-700',
  bounced: 'bg-red-50 text-red-700',
};

function formatDate(iso?: string): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return '-';
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
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load events.'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadEvents(); }, [token]);

  const handleUpdateStatus = async (event: OutreachEvent, outcome: 'replied' | 'bounced') => {
    setUpdating(event.id);
    try {
      await trackEvent(token, {
        contact_id: event.contact.id,
        channel: event.channel,
        outcome,
      });
      setEvents((prev) =>
        prev.map((e) =>
          e.id === event.id ? { ...e, status: outcome } : e,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update status.');
    } finally {
      setUpdating(null);
    }
  };

  return (
    <div className="flex min-h-full animate-slide-in-right flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-gray-100 bg-white/95 px-4 py-3 backdrop-blur">
        <button
          onClick={onBack}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          title="Back"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h2 className="text-sm font-semibold text-gray-900">Outreach tracker</h2>
      </div>

      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col gap-3 px-4 py-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div
                key={i}
                className="flex animate-fade-in-up items-center gap-3"
                style={{ animationDelay: `${i * 70}ms` }}
              >
                <div className="skeleton animate-shimmer h-9 w-9 flex-shrink-0 rounded-full" />
                <div className="flex flex-1 flex-col gap-1.5">
                  <SkeletonBar width="50%" height={10} />
                  <SkeletonBar width="35%" height={9} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col">
            {error && (
              <div className="px-4 pt-3">
                <WarningBanner message={error} variant="error" />
              </div>
            )}

            {events.length === 0 ? (
              <div className="flex animate-fade-in flex-col items-center justify-center gap-3 px-4 py-12 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-50 text-2xl">
                  📬
                </div>
                <div>
                  <p className="text-sm font-semibold text-gray-700">Nothing tracked yet</p>
                  <p className="mt-1 text-xs leading-relaxed text-gray-400">
                    Every email you draft shows up here so you can watch the replies roll in.
                  </p>
                </div>
                <button
                  onClick={onBack}
                  className="text-xs font-semibold text-brand-600 hover:text-brand-700"
                >
                  Find your people
                </button>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {events.map((event, i) => (
                  <div
                    key={event.id}
                    className="flex animate-fade-in-up flex-col gap-1.5 px-4 py-3"
                    style={{ animationDelay: `${i * 45}ms` }}
                  >
                    <div className="flex items-start justify-between gap-2.5">
                      <Avatar name={event.contact.full_name} size={36} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-gray-900">
                          {event.contact.full_name}
                        </p>
                        <p className="truncate text-xs text-gray-500">
                          {event.contact.company_domain}
                        </p>
                        {event.subject && (
                          <p className="mt-0.5 truncate text-xs italic text-gray-400">
                            {event.subject}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-shrink-0 flex-col items-end gap-1">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_COLORS[event.status]}`}
                        >
                          {event.status.charAt(0).toUpperCase() + event.status.slice(1)}
                        </span>
                        <span className="text-[11px] text-gray-400">
                          {formatDate(event.sent_at)}
                        </span>
                      </div>
                    </div>

                    {(event.status === 'sent' || event.status === 'drafted') && (
                      <div className="mt-0.5 flex gap-2 pl-[46px]">
                        <button
                          onClick={() => handleUpdateStatus(event, 'replied')}
                          disabled={updating === event.id}
                          className="flex-1 rounded-lg border border-green-200 px-2 py-1 text-[11px] font-medium text-green-700 transition-colors hover:bg-green-50 active:scale-[0.98] disabled:opacity-50"
                        >
                          Mark replied
                        </button>
                        <button
                          onClick={() => handleUpdateStatus(event, 'bounced')}
                          disabled={updating === event.id}
                          className="flex-1 rounded-lg border border-red-200 px-2 py-1 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-50 active:scale-[0.98] disabled:opacity-50"
                        >
                          Mark bounced
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
