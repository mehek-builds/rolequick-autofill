import React, { useEffect, useState } from 'react';
import { generateDraft, trackEvent } from '../lib/api';
import { buildGmailComposeLink } from '../lib/gmail';
import type { Contact, Draft, JobContext, Profile } from '../lib/types';
import { SkeletonDraft } from './Skeleton';
import WarningBanner from './WarningBanner';
import {
  PendingLabel,
  PopupHeader,
  primaryButtonClass,
  secondaryButtonClass,
  StatusDot,
  textAreaClass,
  textButtonClass,
  fieldClass,
} from './ui';

interface DraftEditorProps {
  contact: Contact;
  job: JobContext;
  token: string;
  profile: Profile;
  onBack: () => void;
  onDraftAnother: () => void;
  prebuiltDraft?: Draft | null;
}

export default function DraftEditor({
  contact,
  job,
  token,
  profile,
  onBack,
  onDraftAnother,
  prebuiltDraft,
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

  useEffect(() => {
    if (prebuiltDraft) {
      setDraft(prebuiltDraft);
      setSubject(prebuiltDraft.subject);
      setBody(prebuiltDraft.body);
      setLoading(false);
      return;
    }

    generateDraft(token, {
      contact,
      role: job.role,
      company: job.company,
      user_profile: profile,
    })
      .then((nextDraft) => {
        setDraft(nextDraft);
        setSubject(nextDraft.subject);
        setBody(nextDraft.body);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Could not generate the draft.');
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
        const textArea = document.createElement('textarea');
        textArea.value = `Subject: ${subject}\n\n${body}`;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        setError('Could not copy the draft.');
      }
    }
  };

  const handleOpenGmail = async () => {
    const link = buildGmailComposeLink(contact.email ?? '', subject, body);
    try {
      await chrome.tabs.create({ url: link });
      setGmailOpened(true);
      setTimeout(() => setGmailOpened(false), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open Gmail.');
    }
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
      setError(err instanceof Error ? err.message : 'Could not mark the draft as sent.');
    } finally {
      setMarkingSent(false);
    }
  };

  return (
    <div className="flex min-h-full animate-slide-in-right flex-col bg-white">
      <PopupHeader title="Draft email" subtitle={`${contact.full_name} · ${contact.title}`} onBack={onBack} />

      <main className="flex flex-1 flex-col gap-4 px-4 py-4">
        {loading ? (
          <div className="flex flex-col gap-3" role="status" aria-live="polite">
            <p className="text-sm text-gray-600">Writing your draft…</p>
            <SkeletonDraft />
          </div>
        ) : error && !draft ? (
          <WarningBanner message={error} variant="error" />
        ) : draft ? (
          <>
            {error && <WarningBanner message={error} variant="error" />}

            {draft.warnings.map((warning, index) => (
              <WarningBanner key={index} message={warning} variant="warning" />
            ))}

            {markedSent && (
              <div className="flex min-h-11 items-center gap-2 border-y border-success-200 py-2 text-sm font-medium text-success-700" role="status" aria-live="polite">
                <StatusDot tone="success" />
                Logged as sent
              </div>
            )}

            <div className="flex items-center gap-2 border-b border-gray-200 pb-3 text-xs text-gray-600">
              <StatusDot tone={contact.status === 'verified' ? 'success' : 'warning'} />
              <span className="truncate">To {contact.email ?? contact.linkedin_url ?? contact.full_name}</span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="draft-subject" className="text-sm font-medium text-gray-800">Subject</label>
              <input
                id="draft-subject"
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className={fieldClass}
              />
            </div>

            <div className="flex flex-1 flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor="draft-body" className="text-sm font-medium text-gray-800">Message</label>
                <span className="text-xs tabular-nums text-gray-600">{wordCount} words</span>
              </div>
              <textarea
                id="draft-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                className={textAreaClass}
              />
            </div>
          </>
        ) : null}
      </main>

      {draft && !loading && (
        <footer className="sticky bottom-0 z-20 border-t border-gray-200 bg-white px-4 py-3">
          <div className="flex gap-2">
            <button type="button" onClick={handleCopy} className={`${secondaryButtonClass} flex-1`}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" onClick={handleOpenGmail} className={`${primaryButtonClass} flex-[1.5]`}>
              {gmailOpened ? 'Opened Gmail' : 'Open in Gmail'}
            </button>
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <button type="button" onClick={onDraftAnother} className={textButtonClass}>Draft another</button>
            <button
              type="button"
              onClick={handleMarkSent}
              disabled={markingSent || markedSent}
              className={textButtonClass}
            >
              {markingSent ? <PendingLabel>Saving…</PendingLabel> : markedSent ? 'Marked sent' : 'Mark as sent'}
            </button>
          </div>
          {(copied || gmailOpened) && (
            <span className="sr-only" role="status" aria-live="polite">
              {copied ? 'Draft copied' : 'Gmail opened'}
            </span>
          )}
        </footer>
      )}
    </div>
  );
}
