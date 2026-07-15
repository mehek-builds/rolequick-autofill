import React, { useState } from 'react';
import type { Contact, Persona } from '../lib/types';
import Avatar from './Avatar';

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

// Neutral-leaning pills. Brand color is reserved for the CTA + the alum signal,
// which is RoleQuick's differentiator and the one badge that earns real color.
const PERSONA_COLORS: Record<Persona, string> = {
  alumni: 'bg-brand-50 text-brand-700',
  near_peer: 'bg-teal-50 text-teal-700',
  senior_ic: 'bg-violet-50 text-violet-700',
  hiring_manager: 'bg-fuchsia-50 text-fuchsia-700',
  recruiter: 'bg-gray-100 text-gray-600',
};

// The universal green/amber/grey confidence model, as an 8px dot left of the email.
function ConfidenceDot({ status }: { status: Contact['status'] }) {
  const map: Record<Contact['status'], { color: string; label: string }> = {
    verified: { color: '#22C55E', label: 'Verified email' },
    likely: { color: '#EAB308', label: 'Likely email' },
    linkedin_only: { color: '#9CA3AF', label: 'LinkedIn only' },
    none: { color: '#D1D5DB', label: 'No contact' },
  };
  const { color, label } = map[status];
  return (
    <span
      className="inline-block h-2 w-2 flex-shrink-0 rounded-full"
      style={{ backgroundColor: color }}
      title={label}
    />
  );
}

function StatusBadge({ status }: { status: Contact['status'] }) {
  if (status === 'linkedin_only') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700">
        <span className="text-[9px] font-bold">in</span>
        LinkedIn only
      </span>
    );
  }
  if (status === 'verified') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
        <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
        Verified
      </span>
    );
  }
  if (status === 'likely') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
        Likely
      </span>
    );
  }
  return null;
}

export default function ContactCard({ contact, onDraft }: ContactCardProps) {
  const isLinkedInOnly = contact.status === 'linkedin_only';
  const contactLine = isLinkedInOnly ? contact.linkedin_url : contact.email;
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!contactLine) return;
    try {
      await navigator.clipboard.writeText(contactLine);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked - silently ignore, the value is still visible */
    }
  };

  return (
    <div className="group rounded-xl border border-gray-100 bg-white p-3.5 shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-brand-100 hover:shadow-card-hover">
      <div className="flex items-start gap-3">
        <Avatar name={contact.full_name} size={40} ring={contact.school_match} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-semibold text-gray-900">{contact.full_name}</p>
            {contact.school_match && (
              <span className="flex-shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-semibold text-brand-700">
                alum
              </span>
            )}
          </div>
          <p className="truncate text-[13px] leading-snug text-gray-500">{contact.title}</p>

          {contactLine && (
            <div className="mt-1 flex animate-reveal items-center gap-1.5">
              <ConfidenceDot status={contact.status} />
              <span className="truncate text-xs text-gray-400">{contactLine}</span>
              {!isLinkedInOnly && (
                <button
                  onClick={handleCopy}
                  className="ml-auto flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-gray-300 transition-colors hover:bg-gray-100 hover:text-gray-500"
                  title={copied ? 'Copied' : 'Copy email'}
                >
                  {copied ? (
                    <svg className="h-3.5 w-3.5 animate-check-pop text-green-500" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  ) : (
                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2v-2m-6-12h6a2 2 0 012 2v6m-8-8V3a2 2 0 012-2" />
                    </svg>
                  )}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${PERSONA_COLORS[contact.persona]}`}>
          {PERSONA_LABELS[contact.persona]}
        </span>
        <StatusBadge status={contact.status} />
      </div>

      {contact.status === 'likely' && (
        <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
          Worth a double-check before you send.
        </p>
      )}

      <button
        onClick={() => onDraft(contact)}
        className="mt-3 w-full rounded-lg bg-brand-600 px-3 py-2 text-[13px] font-semibold text-white shadow-sm transition-all duration-150 hover:bg-brand-700 active:scale-[0.98] focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-1"
      >
        {isLinkedInOnly ? 'Draft a DM' : 'Draft email'}
      </button>
    </div>
  );
}
