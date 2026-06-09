import React, { useState, useEffect } from 'react';
import { generateDraft, trackEvent } from '../lib/api';
import type { Contact, Draft, JobContext, Profile } from '../lib/types';
import { buildGmailComposeLink } from '../lib/gmail';
import WarningBanner from './WarningBanner';
import Avatar from './Avatar';
import Confetti from './Confetti';
import { SkeletonDraft } from './Skeleton';

interface DraftEditorProps {
  contact: Contact;
  job: JobContext;
  token: string;
  profile: Profile;
  onBack: () => void;
  onDraftAnother: () => void;
}

export default function DraftEditor({
  contact,
  job,
  token,
  profile,
  onBack,
  onDraftAnother,
}: DraftEditorProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [gmailOpened, setGmailOpened] = useState(false);
  const [markingSent, setMarkingSent] = useState(false);
  const [markedSent, setMarkedSent] = useState(false);
  const [celebrate, setCelebrate] = useState(false);

  useEffect(() => {
    generateDraft(token, {
      contact,
      role: job.role,
      company: job.company,
      user_profile: profile,
    })
      .then((d) => {
        setDraft(d);
        setSubject(d.subject);
        setBody(d.body);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to generate draft.');
      })
      .finally(() => setLoading(false));
  }, []);

  const wordCount = body.trim().split(/\s+/).filter(Boolean).length;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      try {
        const el = document.createElement('textarea');
        el.value = `Subject: ${subject}\n\n${body}`;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        setError('Could not copy to clipboard.');
      }
    }
  };

  const handleOpenGmail = () => {
    const to = contact.email ?? '';
    const link = buildGmailComposeLink(to, subject, body);
    chrome.tabs.create({ url: link });
    setGmailOpened(true);
    setTimeout(() => setGmailOpened(false), 2000);
  };

  const handleMarkSent = async () => {
    setMarkingSent(true);
    try {
      const channel = contact.status === 'linkedin_only' ? 'linkedin' : 'email';
      await trackEvent(token, {
        contact_id: contact.id,
        channel,
        subject,
        draft_text: body,
        outcome: 'sent',
      });
      setMarkedSent(true);
      setCelebrate(true);
      setTimeout(() => setCelebrate(false), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark as sent.');
    } finally {
      setMarkingSent(false);
    }
  };

  return (
    <div className="relative flex min-h-full animate-slide-in-right flex-col">
      {celebrate && <Confetti />}

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
        <Avatar name={contact.full_name} size={32} ring={contact.school_match} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-gray-900">{contact.full_name}</p>
          <p className="truncate text-xs text-gray-500">{contact.title}</p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-gray-400">Writing something that sounds like you...</p>
            <SkeletonDraft />
          </div>
        ) : error && !draft ? (
          <WarningBanner message={error} variant="error" />
        ) : draft ? (
          <>
            {error && <WarningBanner message={error} variant="error" />}

            {draft.warnings.map((w, i) => (
              <WarningBanner key={i} message={w} variant="warning" />
            ))}

            {markedSent && (
              <div className="flex animate-pop-in items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-3 py-2.5">
                <span className="text-base">🎉</span>
                <p className="text-xs font-semibold text-green-800">
                  Logged as sent. Nice work, that's one more shot taken.
                </p>
              </div>
            )}

            <div className="flex animate-fade-in flex-col gap-1.5">
              <label className="text-xs font-medium text-gray-600">Subject</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 text-sm transition-colors focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100"
              />
            </div>

            <div className="flex flex-1 animate-fade-in flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-gray-600">Body</label>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500">
                  {wordCount} words
                </span>
              </div>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={9}
                className="w-full resize-none rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 text-sm leading-relaxed transition-colors focus:border-brand-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleCopy}
                className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-1 active:scale-[0.98] ${
                  copied
                    ? 'bg-green-600 text-white focus:ring-green-500'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-gray-400'
                }`}
              >
                {copied ? (
                  <span className="inline-flex items-center justify-center gap-1">
                    <svg className="h-3.5 w-3.5 animate-check-pop" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    Copied
                  </span>
                ) : (
                  'Copy draft'
                )}
              </button>
              <button
                onClick={handleOpenGmail}
                className="flex-1 rounded-lg bg-brand-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition-all duration-150 hover:bg-brand-700 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1"
              >
                {gmailOpened ? (
                  <span className="inline-flex items-center justify-center gap-1">
                    <svg className="h-3.5 w-3.5 animate-check-pop" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    Opened
                  </span>
                ) : (
                  'Open in Gmail'
                )}
              </button>
            </div>

            <div className="flex gap-2">
              <button
                onClick={onDraftAnother}
                className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-50 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-1"
              >
                Draft another
              </button>
              <button
                onClick={handleMarkSent}
                disabled={markingSent || markedSent}
                className="flex-1 rounded-lg border border-brand-200 px-3 py-2 text-xs font-semibold text-brand-700 transition-colors hover:bg-brand-50 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-brand-400 focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {markingSent ? 'Saving...' : markedSent ? 'Sent ✓' : 'Mark as sent'}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
