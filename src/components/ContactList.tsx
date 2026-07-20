import React from 'react';
import type { Contact, JobContext } from '../lib/types';
import ContactCard from './ContactCard';
import { SkeletonContactList } from './Skeleton';
import { PopupHeader, SectionLabel, textButtonClass } from './ui';

interface ContactListProps {
  contacts: Contact[];
  job: JobContext;
  loading: boolean;
  onDraft: (contact: Contact) => void;
  onBack: () => void;
}

export default function ContactList({ contacts, job, loading, onDraft, onBack }: ContactListProps) {
  return (
    <div className="flex min-h-full animate-slide-in-right flex-col bg-white">
      <PopupHeader title={job.company} subtitle={job.role} onBack={onBack} />

      <main className="flex flex-1 flex-col px-4 py-4">
        {loading ? (
          <div className="flex flex-col gap-3" role="status" aria-live="polite">
            <p className="text-sm text-gray-600">Finding contacts…</p>
            <SkeletonContactList count={3} />
          </div>
        ) : contacts.length === 0 ? (
          <div className="flex flex-1 flex-col items-start justify-center gap-3">
            <SectionLabel>No contacts found</SectionLabel>
            <h2 className="text-xl font-semibold text-gray-950">Try a broader search</h2>
            <p className="text-sm leading-5 text-gray-600">
              Use the parent company name or a less specific role title.
            </p>
            <button type="button" onClick={onBack} className={textButtonClass}>
              Edit the job
            </button>
          </div>
        ) : (
          <section aria-labelledby="contact-results-heading">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div id="contact-results-heading"><SectionLabel>Best matches</SectionLabel></div>
              <span className="text-xs text-gray-600">{contacts.length} found</span>
            </div>
            <p className="mb-2 text-sm text-gray-600">Ranked by likelihood of a reply.</p>
            <div className="divide-y divide-gray-200 border-y border-gray-200">
              {contacts.map((contact) => (
                <ContactCard key={contact.id} contact={contact} onDraft={onDraft} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
