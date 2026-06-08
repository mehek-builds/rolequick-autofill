import React from 'react';
import type { Contact, Persona, Tier } from '../lib/types';

interface ContactCardProps {
  contact: Contact;
  onDraft: (contact: Contact) => void;
}

const PERSONA_LABELS: Record<Persona, string> = {
  alumni: 'Alumni',
  near_peer: 'Near Peer',
  senior_ic: 'Senior IC',
  hiring_manager: 'Hiring Manager',
  recruiter: 'Recruiter',
};

const PERSONA_COLORS: Record<Persona, string> = {
  alumni: 'bg-blue-100 text-blue-800',
  near_peer: 'bg-teal-100 text-teal-800',
  senior_ic: 'bg-violet-100 text-violet-800',
  hiring_manager: 'bg-purple-100 text-purple-800',
  recruiter: 'bg-gray-100 text-gray-700',
};

function TierBadge({ tier, status }: { tier: Tier; status: Contact['status'] }) {
  if (status === 'linkedin_only') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
        <span className="font-bold text-blue-600 text-[10px]">in</span>
        LinkedIn only
      </span>
    );
  }
  if (status === 'verified') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800">
        <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
        </svg>
        Verified
      </span>
    );
  }
  if (status === 'likely') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800">
        <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
          <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
        </svg>
        Likely
      </span>
    );
  }
  return null;
}

export default function ContactCard({ contact, onDraft }: ContactCardProps) {
  const isLinkedInOnly = contact.status === 'linkedin_only';

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 flex flex-col gap-2 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold text-gray-900 truncate">{contact.full_name}</p>
            {contact.school_match && (
              <span className="text-xs text-indigo-600 font-medium">(alum)</span>
            )}
          </div>
          <p className="text-xs text-gray-500 truncate">{contact.title}</p>
          {contact.email && !isLinkedInOnly && (
            <p className="text-xs text-gray-400 truncate mt-0.5">{contact.email}</p>
          )}
          {isLinkedInOnly && contact.linkedin_url && (
            <p className="text-xs text-gray-400 truncate mt-0.5">{contact.linkedin_url}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PERSONA_COLORS[contact.persona]}`}>
          {PERSONA_LABELS[contact.persona]}
        </span>
        <TierBadge tier={contact.tier} status={contact.status} />
      </div>

      {contact.status === 'likely' && (
        <p className="text-xs text-yellow-700 bg-yellow-50 rounded px-2 py-1">
          Double-check before sending
        </p>
      )}

      <button
        onClick={() => onDraft(contact)}
        className="w-full rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1"
      >
        {isLinkedInOnly ? 'Draft DM' : 'Draft email'}
      </button>
    </div>
  );
}
