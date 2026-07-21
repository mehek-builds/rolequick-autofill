import React, { useState } from 'react';
import type { Contact, Persona } from '../lib/types';
import Avatar from './Avatar';
import { StatusDot, textButtonClass } from './ui';

interface ContactCardProps {
  contact: Contact;
  onDraft: (contact: Contact) => void;
}

const PERSONA_LABELS: Record<Persona, string> = {
  alumni: 'Alum',
  near_peer: 'Near peer',
  senior_ic: 'Senior IC',
  hiring_manager: 'Hiring manager',
  recruiter: 'Recruiter',
};

const STATUS_LABELS: Record<Contact['status'], string> = {
  verified: 'Verified',
  likely: 'Likely',
  linkedin_only: 'LinkedIn only',
  none: 'No contact details',
};

export default function ContactCard({ contact, onDraft }: ContactCardProps) {
  const isLinkedInOnly = contact.status === 'linkedin_only';
  const contactLine = isLinkedInOnly ? contact.linkedin_url : contact.email;
  const [copied, setCopied] = useState(false);
  const tone = contact.status === 'verified' ? 'success' : contact.status === 'likely' ? 'warning' : 'neutral';

  const handleCopy = async () => {
    if (!contactLine) return;
    try {
      await navigator.clipboard.writeText(contactLine);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      return;
    }
  };

  const metadata = [
    contact.school_match ? 'School alum' : PERSONA_LABELS[contact.persona],
    STATUS_LABELS[contact.status],
  ].join(' · ');

  return (
    <article className="flex min-h-[88px] items-start gap-3 py-3">
      <Avatar name={contact.full_name} size={36} ring={contact.school_match} />

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-gray-950">{contact.full_name}</h3>
            <p className="truncate text-sm text-gray-600">{contact.title}</p>
          </div>
          <button
            type="button"
            onClick={() => onDraft(contact)}
            className={textButtonClass}
            aria-label={`${isLinkedInOnly ? 'Draft a LinkedIn message to' : 'Draft an email to'} ${contact.full_name}`}
          >
            Draft
          </button>
        </div>

        <div className="mt-1 flex items-center gap-1.5 text-xs text-gray-600">
          <StatusDot tone={tone} />
          <span>{metadata}</span>
        </div>

        {contactLine && (
          <div className="mt-1 flex min-h-10 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-gray-600">{contactLine}</span>
            {!isLinkedInOnly && (
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-md text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                aria-label={copied ? `${contact.full_name}'s email copied` : `Copy ${contact.full_name}'s email`}
              >
                {copied ? (
                  <svg className="h-4 w-4 text-success-600" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2v-2m-6-12h6a2 2 0 012 2v6m-8-8V3a2 2 0 012-2" />
                  </svg>
                )}
              </button>
            )}
          </div>
        )}

        {contact.status === 'likely' && (
          <p className="text-xs text-warning-700">Verify this address before sending.</p>
        )}

        {copied && <span className="sr-only" role="status" aria-live="polite">Email copied</span>}
      </div>
    </article>
  );
}
