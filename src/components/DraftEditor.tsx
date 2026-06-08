import React, { useState, useEffect } from 'react';
import { generateDraft, trackEvent } from '../lib/api';
import type { Contact, Draft, JobContext, Profile } from '../lib/types';
import { buildGmailComposeLink } from '../lib/gmail';
import LoadingSpinner from './LoadingSpinner';
import WarningBanner from './WarningBanner';

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
  const [markingSent, setMarkingSent] = useState(false);
  const [markedSent, setMarkedSent] = useState(false);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark as sent.');
    } finally {
      setMarkingSent(false);
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
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900 truncate">
            Draft for {contact.full_name}
          </p>
          <p className="text-xs text-gray-500 truncate">{contact.title}</p>
        </div>
      </div>

      <div className="flex-1 px-4 py-4 overflow-y-auto flex flex-col gap-3">
        {loading ? (
          <LoadingSpinner message="Generating your personalized draft..." size="lg" />
        ) : error && !draft ? (
          <WarningBanner message={error} variant="error" />
        ) : draft ? (
          <>
            {error && <WarningBanner message={error} variant="error" />}

            {draft.warnings.map((w, i) => (
              <WarningBanner key={i} message={w} variant="warning" />
            ))}

            {markedSent && (
              <WarningBanner message="Marked as sent. Good luck!" variant="info" />
            )}

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-700">Subject</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>

            <div className="flex flex-col gap-1 flex-1">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-gray-700">Body</label>
                <span className="text-xs text-gray-400">{wordCount} words</span>
              </div>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={9}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 resize-none font-sans leading-relaxed"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={handleCopy}
                className={`flex-1 rounded-md px-3 py-2 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1 ${
                  copied
                    ? 'bg-green-600 text-white focus:ring-green-500'
                    : 'bg-gray-100 text-gray-700 hover:bg-gray-200 focus:ring-gray-400'
                }`}
              >
                {copied ? 'Copied!' : 'Copy draft'}
              </button>
              <button
                onClick={handleOpenGmail}
                className="flex-1 rounded-md bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1"
              >
                Open in Gmail
              </button>
            </div>

            <div className="flex gap-2">
              <button
                onClick={onDraftAnother}
                className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-50 transition-colors focus:outline-none focus:ring-2 focus:ring-gray-400 focus:ring-offset-1"
              >
                Draft another
              </button>
              <button
                onClick={handleMarkSent}
                disabled={markingSent || markedSent}
                className="flex-1 rounded-md border border-indigo-300 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-1 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {markingSent ? 'Saving...' : markedSent ? 'Sent!' : 'Mark as sent'}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
