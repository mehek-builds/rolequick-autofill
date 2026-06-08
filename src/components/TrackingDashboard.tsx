import React, { useState, useEffect } from 'react';
import { getEvents, trackEvent } from '../lib/api';
import type { OutreachEvent, OutreachStatus } from '../lib/types';
import LoadingSpinner from './LoadingSpinner';
import WarningBanner from './WarningBanner';

interface TrackingDashboardProps {
  token: string;
  onBack: () => void;
}

const STATUS_COLORS: Record<OutreachStatus, string> = {
  drafted: 'bg-gray-100 text-gray-700',
  sent: 'bg-yellow-100 text-yellow-800',
  replied: 'bg-green-100 text-green-800',
  bounced: 'bg-red-100 text-red-800',
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
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100">
        <button
          onClick={onBack}
          className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
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
          <div className="px-4 py-4">
            <LoadingSpinner message="Loading your outreach..." />
          </div>
        ) : (
          <div className="flex flex-col">
            {error && (
              <div className="px-4 pt-3">
                <WarningBanner message={error} variant="error" />
              </div>
            )}

            {events.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 gap-3 text-center px-4">
                <svg className="h-10 w-10 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                </svg>
                <div>
                  <p className="text-sm font-medium text-gray-700">No outreach yet</p>
                  <p className="text-xs text-gray-400 mt-1">
                    Find contacts and draft emails to track your progress.
                  </p>
                </div>
                <button
                  onClick={onBack}
                  className="text-xs text-indigo-600 font-medium hover:text-indigo-700"
                >
                  Find contacts
                </button>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {events.map((event) => (
                  <div key={event.id} className="px-4 py-3 flex flex-col gap-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-900 truncate">
                          {event.contact.full_name}
                        </p>
                        <p className="text-xs text-gray-500 truncate">
                          {event.contact.company_domain}
                        </p>
                        {event.subject && (
                          <p className="text-xs text-gray-400 truncate mt-0.5 italic">
                            {event.subject}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[event.status]}`}
                        >
                          {event.status.charAt(0).toUpperCase() + event.status.slice(1)}
                        </span>
                        <span className="text-xs text-gray-400">
                          {formatDate(event.sent_at)}
                        </span>
                      </div>
                    </div>

                    {(event.status === 'sent' || event.status === 'drafted') && (
                      <div className="flex gap-2 mt-0.5">
                        <button
                          onClick={() => handleUpdateStatus(event, 'replied')}
                          disabled={updating === event.id}
                          className="flex-1 rounded border border-green-300 px-2 py-1 text-xs font-medium text-green-700 hover:bg-green-50 transition-colors disabled:opacity-50"
                        >
                          Mark replied
                        </button>
                        <button
                          onClick={() => handleUpdateStatus(event, 'bounced')}
                          disabled={updating === event.id}
                          className="flex-1 rounded border border-red-200 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
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
