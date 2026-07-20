import React, { useState, useEffect } from 'react';
import { resolveContacts, getEvents } from '../lib/api';
import type { Contact, OutreachEvent, JobContext } from '../lib/types';
import WarningBanner from './WarningBanner';
import Avatar from './Avatar';
import { SkeletonContactList, SkeletonBar } from './Skeleton';
import BrandMark from './BrandMark';

interface MainScreenProps {
  token: string;
  detectedJob?: JobContext | null;
  pendingDraftCount?: number;
  onViewDrafts?: () => void;
  onContactsFound: (contacts: Contact[], job: JobContext) => void;
  onViewTracking: () => void;
  onViewAutofillSetup: () => void;
  onLogout: () => void;
  userSchool?: string;
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === 'replied' ? '#22C55E' : status === 'sent' ? '#EAB308' : '#D1D5DB';
  return (
    <span
      className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

const inputClass =
  'w-full rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 transition-colors focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100';

function slugToName(slug: string): string {
  return slug
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseJobUrl(url: string): { company?: string } {
  try {
    const u = new URL(url);
    const h = u.hostname;
    const parts = u.pathname.split('/').filter(Boolean);

    if (h.includes('greenhouse.io') && parts[0]) {
      return { company: slugToName(parts[0]) };
    }
    if (h.includes('lever.co') && parts[0]) {
      return { company: slugToName(parts[0]) };
    }
    if (h.includes('ashbyhq.com') && parts[0]) {
      return { company: slugToName(parts[0]) };
    }
    if (h.includes('myworkdayjobs.com') || h.includes('workday.com')) {
      const slug = h.split('.')[0].replace(/^www/, '');
      if (slug) return { company: slugToName(slug) };
    }
    if (h.includes('joinhandshake.com') && parts[1]) {
      return { company: slugToName(parts[1]) };
    }
  } catch {
    // invalid URL, ignore
  }
  return {};
}

export default function MainScreen({
  token,
  detectedJob,
  pendingDraftCount = 0,
  onViewDrafts,
  onContactsFound,
  onViewTracking,
  onViewAutofillSetup,
  onLogout,
  userSchool,
}: MainScreenProps) {
  const [jobUrl, setJobUrl] = useState(detectedJob?.url ?? '');
  const [company, setCompany] = useState(detectedJob?.company ?? '');
  const [role, setRole] = useState(detectedJob?.role ?? '');
  const [showManual, setShowManual] = useState(!!detectedJob?.company);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentEvents, setRecentEvents] = useState<OutreachEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [fillError, setFillError] = useState<string | null>(null);

  // Company career sites that host their own application form aren't in the manifest's
  // matches, so Litos can't see them until the student asks. Clicking here is the ask:
  // the toolbar interaction grants activeTab for this one tab, and the content script is
  // injected on demand. Its generic adapter takes over from there.
  const handleFillThisPage = async () => {
    setFillError(null);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setFillError('Could not find the current tab.');
        return;
      }
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content-scripts/content.js'],
      });
      window.close(); // hand off to the on-page card
    } catch {
      setFillError("Chrome doesn't allow extensions on this page (new tab, chrome://, or the Web Store).");
    }
  };

  useEffect(() => {
    getEvents(token)
      .then((events) => setRecentEvents(events.slice(0, 3)))
      .catch(() => {})
      .finally(() => setEventsLoading(false));
  }, [token]);

  // detectedJob arrives asynchronously (the background GET_LAST_JOB callback and the live
  // JOB_DETECTED listener both resolve after this component has already mounted). The field
  // state is seeded via useState, which only reads its initial value once, so a job spotted
  // on the page would never reach the inputs without this sync. Only fill blank fields so we
  // never clobber what the user is actively typing.
  useEffect(() => {
    if (!detectedJob) return;
    if (detectedJob.company) setCompany((prev) => prev || detectedJob.company);
    if (detectedJob.role) setRole((prev) => prev || detectedJob.role);
    if (detectedJob.url) setJobUrl((prev) => prev || detectedJob.url!);
    if (detectedJob.company || detectedJob.role) setShowManual(true);
  }, [detectedJob]);

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setJobUrl(val);
    setError(null);
    if (val.trim() === '') {
      setShowManual(false);
      return;
    }
    setShowManual(true);
    const parsed = parseJobUrl(val);
    if (parsed.company && !company) setCompany(parsed.company);
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
    <div className="flex min-h-full animate-fade-in flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-100 bg-white/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-lg bg-brand-600 text-white">
            <BrandMark className="h-3.5 w-3.5" />
          </div>
          <span className="text-base font-bold tracking-tight text-gray-900">Litos</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onViewAutofillSetup}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            title="Autofill setup"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </button>
          <button
            onClick={onViewTracking}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            title="Tracking dashboard"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </button>
          <button
            onClick={onLogout}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
            title="Sign out"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-4 py-4">
        {loading ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-gray-400">Finding the right people to reach...</p>
            <SkeletonContactList count={3} />
          </div>
        ) : (
          <>
            {pendingDraftCount > 0 && (
              <button
                onClick={onViewDrafts}
                className="flex w-full animate-slide-down items-center gap-2.5 rounded-xl border border-green-200 bg-green-50 px-3 py-2.5 text-left transition-colors hover:bg-green-100/70"
              >
                <span className="flex-shrink-0 text-base">✉️</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-green-800">
                    {pendingDraftCount} draft{pendingDraftCount > 1 ? 's' : ''} ready for you
                  </p>
                  <p className="text-[11px] text-green-600">
                    Litos wrote these in the background, tap to review
                  </p>
                </div>
                <span className="text-sm text-green-400">›</span>
              </button>
            )}

            {detectedJob && (
              <div className="flex animate-slide-down items-start gap-2.5 rounded-xl border border-brand-200 bg-brand-50 px-3 py-2.5">
                <span className="flex-shrink-0 text-base">🎯</span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-brand-700">Spotted a job on this page</p>
                  <p className="truncate text-[11px] text-brand-600">
                    {detectedJob.role} at {detectedJob.company}
                  </p>
                </div>
              </div>
            )}

            <form onSubmit={handleFind} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-gray-600">Job link</label>
                <input
                  type="url"
                  value={jobUrl}
                  onChange={handleUrlChange}
                  placeholder="Paste a LinkedIn or job-board URL"
                  className={inputClass}
                />
              </div>

              {showManual && (
                <div className="flex animate-slide-down flex-col gap-2 rounded-xl border border-gray-100 bg-gray-50 p-3">
                  <p className="text-[11px] font-medium text-gray-500">Confirm the details</p>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium text-gray-600">Company</label>
                    <input
                      type="text"
                      value={company}
                      onChange={(e) => setCompany(e.target.value)}
                      placeholder="e.g. Stripe"
                      className={inputClass}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-medium text-gray-600">Role</label>
                    <input
                      type="text"
                      value={role}
                      onChange={(e) => setRole(e.target.value)}
                      placeholder="e.g. Software Engineer Intern"
                      className={inputClass}
                    />
                  </div>
                </div>
              )}

              {!showManual && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-gray-600">Or type it in directly</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={company}
                      onChange={(e) => {
                        setCompany(e.target.value);
                        setShowManual(true);
                      }}
                      placeholder="Company"
                      className={inputClass}
                    />
                    <input
                      type="text"
                      value={role}
                      onChange={(e) => {
                        setRole(e.target.value);
                        setShowManual(true);
                      }}
                      placeholder="Role"
                      className={inputClass}
                    />
                  </div>
                </div>
              )}

              {error && <WarningBanner message={error} variant="error" />}

              <button
                type="submit"
                className="w-full rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-150 hover:bg-brand-700 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
              >
                Find my people
              </button>
            </form>

            {/* On-demand fill for company-hosted application forms */}
            <div className="flex flex-col gap-1.5 rounded-xl border border-gray-100 bg-gray-50 p-3">
              <p className="text-[11px] font-medium text-gray-500">
                On a company's own application page? Litos can fill it here too.
              </p>
              <button
                type="button"
                onClick={handleFillThisPage}
                className="w-full rounded-lg border border-brand-200 bg-white px-4 py-2 text-sm font-semibold text-brand-700 transition-all duration-150 hover:bg-brand-50 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
              >
                Fill the form on this page
              </button>
              {fillError && <p className="text-[11px] text-red-500">{fillError}</p>}
            </div>

            {/* Recent outreach */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  Recent outreach
                </h3>
                <button
                  onClick={onViewTracking}
                  className="text-xs font-medium text-brand-600 hover:text-brand-700"
                >
                  View all
                </button>
              </div>

              {eventsLoading ? (
                <div className="flex flex-col gap-2 rounded-xl border border-gray-100 p-3">
                  <SkeletonBar width="55%" height={10} />
                  <SkeletonBar width="40%" height={9} />
                </div>
              ) : recentEvents.length === 0 ? (
                <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/50 px-3 py-4 text-center">
                  <p className="text-xs text-gray-400">
                    No outreach yet. Find your people above to get the ball rolling.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-100">
                  {recentEvents.map((event, i) => (
                    <div
                      key={event.id}
                      className="flex animate-fade-in-up items-center gap-2.5 bg-white px-3 py-2.5"
                      style={{ animationDelay: `${i * 50}ms` }}
                    >
                      <Avatar name={event.contact.full_name} size={28} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-gray-900">
                          {event.contact.full_name}
                        </p>
                        <p className="truncate text-[11px] text-gray-400">
                          {event.contact.company_domain}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <StatusDot status={event.status} />
                        <span className="text-[11px] capitalize text-gray-400">{event.status}</span>
                      </div>
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
