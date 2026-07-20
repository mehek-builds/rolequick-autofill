import React, { useEffect, useState } from 'react';
import { getEvents, resolveContacts } from '../lib/api';
import type { Contact, JobContext, OutreachEvent } from '../lib/types';
import Avatar from './Avatar';
import { SkeletonBar } from './Skeleton';
import WarningBanner from './WarningBanner';
import {
  fieldClass,
  iconButtonClass,
  PopupHeader,
  primaryButtonClass,
  secondaryButtonClass,
  SectionLabel,
  StatusDot,
  textButtonClass,
} from './ui';

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

function EventStatus({ status }: { status: string }) {
  const tone = status === 'replied' ? 'success' : status === 'sent' ? 'warning' : 'neutral';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs capitalize text-gray-600">
      <StatusDot tone={tone} />
      {status}
    </span>
  );
}

function slugToName(slug: string): string {
  return slug
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function parseJobUrl(url: string): { company?: string } {
  try {
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname;
    const parts = parsedUrl.pathname.split('/').filter(Boolean);

    if (host.includes('greenhouse.io') && parts[0]) return { company: slugToName(parts[0]) };
    if (host.includes('lever.co') && parts[0]) return { company: slugToName(parts[0]) };
    if (host.includes('ashbyhq.com') && parts[0]) return { company: slugToName(parts[0]) };
    if (host.includes('myworkdayjobs.com') || host.includes('workday.com')) {
      const slug = host.split('.')[0].replace(/^www/, '');
      if (slug) return { company: slugToName(slug) };
    }
    if (host.includes('joinhandshake.com') && parts[1]) return { company: slugToName(parts[1]) };
  } catch {
    return {};
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
  const [editingJob, setEditingJob] = useState(!detectedJob);
  const [jobDetailsTouched, setJobDetailsTouched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentEvents, setRecentEvents] = useState<OutreachEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [fillError, setFillError] = useState<string | null>(null);

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
      window.close();
    } catch {
      setFillError("Chrome does not allow extensions on this page.");
    }
  };

  useEffect(() => {
    getEvents(token)
      .then((events) => setRecentEvents(events.slice(0, 3)))
      .catch((err) => setEventsError(err instanceof Error ? err.message : 'Could not load recent outreach.'))
      .finally(() => setEventsLoading(false));
  }, [token]);

  useEffect(() => {
    if (!detectedJob) return;
    if (detectedJob.company) setCompany((current) => current || detectedJob.company);
    if (detectedJob.role) setRole((current) => current || detectedJob.role);
    if (detectedJob.url) setJobUrl((current) => current || detectedJob.url!);
    if (!jobDetailsTouched && (detectedJob.company || detectedJob.role)) setEditingJob(false);
  }, [detectedJob, jobDetailsTouched]);

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setJobUrl(value);
    setJobDetailsTouched(true);
    setError(null);
    const parsed = parseJobUrl(value);
    if (parsed.company && !company) setCompany(parsed.company);
  };

  const handleFind = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCompany = company.trim();
    const cleanRole = role.trim();
    if (!cleanCompany || !cleanRole) {
      setError('Enter both the company and role.');
      setEditingJob(true);
      return;
    }

    setError(null);
    setLoading(true);
    try {
      const contacts = await resolveContacts(token, {
        company: cleanCompany,
        role: cleanRole,
        user_school: userSchool,
      });
      onContactsFound(contacts, {
        company: cleanCompany,
        role: cleanRole,
        url: jobUrl || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not find contacts. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const hasJob = Boolean(company || role);

  return (
    <div className="flex min-h-full animate-fade-in flex-col bg-white">
      <PopupHeader>
        <button type="button" onClick={onViewAutofillSetup} className={iconButtonClass} aria-label="Application profile" title="Application profile">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M8 6h8M8 10h8M8 14h5m4 7H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z" />
          </svg>
        </button>
        <button type="button" onClick={onViewTracking} className={iconButtonClass} aria-label="Outreach tracker" title="Outreach tracker">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M5 19V9m7 10V5m7 14v-7" />
          </svg>
        </button>
        <button type="button" onClick={onLogout} className={iconButtonClass} aria-label="Sign out" title="Sign out">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M14 8l4 4m0 0l-4 4m4-4H8m4 8H6a2 2 0 01-2-2V6a2 2 0 012-2h6" />
          </svg>
        </button>
      </PopupHeader>

      <main className="flex flex-1 flex-col gap-5 px-4 py-4">
        {pendingDraftCount > 0 && (
          <button
            type="button"
            onClick={onViewDrafts}
            className="flex min-h-14 w-full items-center gap-3 border-b border-gray-200 pb-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <StatusDot tone="success" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-gray-950">
                {pendingDraftCount} draft{pendingDraftCount === 1 ? '' : 's'} ready
              </span>
              <span className="block text-xs text-gray-600">Review before sending</span>
            </span>
            <span className="text-sm font-semibold text-brand-700">Review</span>
          </button>
        )}

        <form onSubmit={handleFind} className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <SectionLabel>{hasJob ? 'Current job' : 'Add a job'}</SectionLabel>
            {hasJob && !editingJob && (
              <button type="button" onClick={() => setEditingJob(true)} className={textButtonClass}>
                Edit
              </button>
            )}
          </div>

          {hasJob && !editingJob ? (
            <div className="flex items-start gap-3 border-b border-gray-200 pb-4">
              <StatusDot tone="brand" />
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-base font-semibold text-gray-950">{company}</h2>
                <p className="truncate text-sm text-gray-600">{role}</p>
              </div>
              <span className="text-xs font-medium text-gray-600">Detected</span>
            </div>
          ) : (
            <div className="flex flex-col gap-3 border-b border-gray-200 pb-4">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="job-url" className="text-sm font-medium text-gray-800">Job link</label>
                <input
                  id="job-url"
                  type="url"
                  value={jobUrl}
                  onChange={handleUrlChange}
                  placeholder="Paste a job URL"
                  className={fieldClass}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="job-company" className="text-sm font-medium text-gray-800">Company</label>
                  <input
                    id="job-company"
                    value={company}
                    onChange={(e) => {
                      setCompany(e.target.value);
                      setJobDetailsTouched(true);
                    }}
                    placeholder="Figma"
                    className={fieldClass}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="job-role" className="text-sm font-medium text-gray-800">Role</label>
                  <input
                    id="job-role"
                    value={role}
                    onChange={(e) => {
                      setRole(e.target.value);
                      setJobDetailsTouched(true);
                    }}
                    placeholder="SWE intern"
                    className={fieldClass}
                  />
                </div>
              </div>
            </div>
          )}

          {error && <WarningBanner message={error} variant="error" />}

          <section aria-labelledby="workflow-heading">
            <div id="workflow-heading"><SectionLabel>Workflow</SectionLabel></div>
            <div className="mt-2 divide-y divide-gray-200 border-y border-gray-200">
              <div className="flex min-h-16 items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-950">Application</p>
                  <p className="text-xs text-gray-600">Fill the open form and stop for review</p>
                </div>
                <button type="button" onClick={handleFillThisPage} className={secondaryButtonClass}>
                  Fill page
                </button>
              </div>
              <div className="flex min-h-16 items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-950">Outreach</p>
                  <p className="text-xs text-gray-600">Find verified people for this role</p>
                </div>
                <StatusDot tone={loading ? 'warning' : 'neutral'} />
              </div>
            </div>
            {fillError && <p className="mt-2 text-xs text-danger-700" role="alert">{fillError}</p>}
          </section>

          <button type="submit" disabled={loading} className={primaryButtonClass}>
            {loading ? 'Finding contacts…' : 'Find contacts'}
          </button>
        </form>

        <section className="flex flex-col gap-2" aria-labelledby="recent-outreach-heading">
          <div className="flex items-center justify-between gap-3">
            <div id="recent-outreach-heading"><SectionLabel>Recent outreach</SectionLabel></div>
            <button type="button" onClick={onViewTracking} className={textButtonClass}>View all</button>
          </div>

          {eventsLoading ? (
            <div className="flex min-h-16 flex-col justify-center gap-2 border-y border-gray-200 py-3">
              <SkeletonBar width="55%" height={10} />
              <SkeletonBar width="40%" height={9} />
            </div>
          ) : eventsError ? (
            <WarningBanner message={eventsError} variant="error" />
          ) : recentEvents.length === 0 ? (
            <p className="border-y border-gray-200 py-4 text-sm text-gray-600">
              No outreach yet. Find contacts for the current job to start.
            </p>
          ) : (
            <div className="divide-y divide-gray-200 border-y border-gray-200">
              {recentEvents.map((event) => (
                <div key={event.id} className="flex min-h-14 items-center gap-3 py-2">
                  <Avatar name={event.contact.full_name} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-950">{event.contact.full_name}</p>
                    <p className="truncate text-xs text-gray-600">{event.contact.company_domain}</p>
                  </div>
                  <EventStatus status={event.status} />
                </div>
              ))}
            </div>
          )}
        </section>

        {loading && <p className="sr-only" role="status" aria-live="polite">Finding contacts</p>}
      </main>
    </div>
  );
}
