import React from 'react';
import type { Contact, JobContext } from '../lib/types';
import ContactCard from './ContactCard';
import { SkeletonContactList } from './Skeleton';

interface ContactListProps {
  contacts: Contact[];
  job: JobContext;
  loading: boolean;
  onDraft: (contact: Contact) => void;
  onBack: () => void;
}

export default function ContactList({
  contacts,
  job,
  loading,
  onDraft,
  onBack,
}: ContactListProps) {
  return (
    <div className="flex min-h-full animate-slide-in-right flex-col">
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
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-gray-900">{job.company}</p>
          <p className="truncate text-xs text-gray-500">{job.role}</p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-gray-400">Finding the right people to reach...</p>
            <SkeletonContactList count={3} />
          </div>
        ) : contacts.length === 0 ? (
          <div className="flex animate-fade-in flex-col items-center justify-center gap-3 py-10 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-50 text-2xl">
              🔍
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-700">No one surfaced yet</p>
              <p className="mt-1 px-4 text-xs leading-relaxed text-gray-400">
                Try a different company spelling or a broader role title - sometimes the team is listed
                under a parent company.
              </p>
            </div>
            <button
              onClick={onBack}
              className="text-xs font-semibold text-brand-600 hover:text-brand-700"
            >
              Try another search
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-gray-500">
              <span className="font-semibold text-gray-700">{contacts.length}</span>{' '}
              {contacts.length !== 1 ? 'people' : 'person'} found, ranked by who's most likely to reply
            </p>
            {contacts.map((contact, i) => (
              <div
                key={contact.id}
                className="animate-fade-in-up"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                <ContactCard contact={contact} onDraft={onDraft} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
