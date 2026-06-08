import React, { useState, useEffect } from 'react';
import { resolveContacts, getEvents } from '../lib/api';
import type { Contact, OutreachEvent, JobContext } from '../lib/types';
import LoadingSpinner from './LoadingSpinner';
import WarningBanner from './WarningBanner';

interface MainScreenProps {
  token: string;
  detectedJob?: JobContext | null;
  pendingDraftCount?: number;
  onDraftsCleared?: () => void;
  onContactsFound: (contacts: Contact[], job: JobContext) => void;
  onViewTracking: () => void;
  onLogout: () => void;
  userSchool?: string;
}

function parseLinkedInJobUrl(url: string): { company?: string; role?: string } {
  try {
    const u = new URL(url);
    if (u.hostname.includes('linkedin.com') && u.pathname.includes('/jobs/view/')) {
      return {};
    }
    return {};
  } catch {
    return {};
  }
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'replied'
      ? 'bg-green-500'
      : status === 'sent'
        ? 'bg-yellow-400'
        : 'bg-gray-300';
  return <span className={`inline-block h-2 w-2 rounded-full flex-shrink-0 ${color}`} />;
}

export default function MainScreen({
  token,
  detectedJob,
  pendingDraftCount = 0,
  onDraftsCleared,
  onContactsFound,
  onViewTracking,
  onLogout,
  userSchool,
}: MainScreenProps) {
  const [jobUrl, setJobUrl] = useState(detectedJob?.url ?? '');
  const [company, setCompany] = useState(detectedJob?.company ?? '');
  const [role, setRole] = useState(detectedJob?.role ?? '');
  const [showManual, setShowManual] = useState(!!(detectedJob?.company));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentEvents, setRecentEvents] = useState<OutreachEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);

  useEffect(() => {
    getEvents(token)
      .then((events) => setRecentEvents(events.slice(0, 3)))
      .catch(() => {})
      .finally(() => setEventsLoading(false));
  }, [token]);

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setJobUrl(val);
    setError(null);
    if (val.includes('linkedin.com/jobs/')) {
      setShowManual(true);
    } else if (val.trim() === '') {
      setShowManual(false);
    } else {
      setShowManual(true);
    }
  };

  const handleFind = async (e: React.FormEvent) => {
    e.preventDefault();
    const co = company.trim();
    const ro = role.trim();
    if (!co || !ro) {
      setError('Please enter both company name and role.');
      return;
    }
    setError(null);
    setLoading(true);

    try {
      const contacts = await resolveContacts(token, {
        company: co,
        role: ro,
        user_school: userSchool,
      });
      onContactsFound(contacts, { company: co, role: ro, url: jobUrl || undefined });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to find contacts. Is the backend running?');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
        <span className="text-base font-bold text-indigo-600 tracking-tight">Volley</span>
        <div className="flex items-center gap-2">
          <button
            onClick={onViewTracking}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            title="Tracking dashboard"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </button>
          <button
            onClick={onLogout}
            className="text-gray-400 hover:text-gray-600 transition-colors"
            title="Sign out"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 px-4 py-4 flex flex-col gap-4">
        {loading ? (
          <LoadingSpinner message="Finding the right contacts..." size="lg" />
        ) : (
          <>
            {pendingDraftCount > 0 && (
              <div className="flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 px-3 py-2.5 cursor-pointer" onClick={onDraftsCleared}>
                <span className="text-base flex-shrink-0">✉️</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-green-800">{pendingDraftCount} outreach draft{pendingDraftCount > 1 ? 's' : ''} ready</p>
                  <p className="text-xs text-green-600">Volley drafted emails in the background - tap to review</p>
                </div>
                <span className="text-green-400 text-sm">›</span>
              </div>
            )}

            {detectedJob && (
              <div className="flex items-start gap-2 rounded-lg bg-indigo-50 border border-indigo-200 px-3 py-2.5">
                <span className="text-base flex-shrink-0">🔥</span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-indigo-800">Job detected on this page</p>
                  <p className="text-xs text-indigo-600 truncate">{detectedJob.role} at {detectedJob.company}</p>
                </div>
              </div>
            )}

            <form onSubmit={handleFind} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-700">Job URL</label>
                <input
                  type="url"
                  value={jobUrl}
                  onChange={handleUrlChange}
                  placeholder="https://linkedin.com/jobs/view/..."
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>

              {showManual && (
                <div className="flex flex-col gap-2 rounded-md bg-gray-50 p-3 border border-gray-200">
                  <p className="text-xs text-gray-500">Confirm the details:</p>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-gray-700">Company</label>
                    <input
                      type="text"
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
                      placeholder="e.g. Stripe"
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-xs font-medium text-gray-700">Role</label>
                    <input
                      type="text"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      placeholder="e.g. Software Engineer Intern"
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                  </div>
                </div>
              )}

              {!showManual && (
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-gray-700">
                    Or enter details directly
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={company}
                      onChange={(e) => { setCompany(e.target.value); setShowManual(true); }}
                      placeholder="Company"
                      className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                    <input
                      type="text"
                      value={role}
                      onChange={(e) => { setRole(e.target.value); setShowManual(true); }}
                      placeholder="Role"
                      className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                    />
                  </div>
                </div>
              )}

              {error && <WarningBanner message={error} variant="error" />}

              <button
                type="submit"
                className="w-full rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 transition-colors"
              >
                Find contacts
              </button>
            </form>

            {/* Recent outreach */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Recent outreach</h3>
                <button
                  onClick={onViewTracking}
                  className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                >
                  View all
                </button>
              </div>

              {eventsLoading ? (
                <LoadingSpinner size="sm" />
              ) : recentEvents.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-3">
                  No outreach yet. Find contacts above to get started.
                </p>
              ) : (
                <div className="flex flex-col divide-y divide-gray-100 rounded-md border border-gray-200 overflow-hidden">
                  {recentEvents.map((event) => (
                    <div key={event.id} className="flex items-center gap-3 px-3 py-2.5 bg-white">
                      <StatusDot status={event.status} />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-gray-900 truncate">
                          {event.contact.full_name}
                        </p>
                        <p className="text-xs text-gray-400 truncate">
                          {event.contact.company_domain}
                        </p>
                      </div>
                      <span className="text-xs text-gray-400 capitalize">{event.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
