import React from 'react';
import type { Contact, JobContext } from '../lib/types';
import ContactCard from './ContactCard';
import LoadingSpinner from './LoadingSpinner';

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
            {job.company}
          </p>
          <p className="text-xs text-gray-500 truncate">{job.role}</p>
        </div>
      </div>

      <div className="flex-1 px-4 py-4 overflow-y-auto">
        {loading ? (
          <LoadingSpinner
            message={`Finding contacts for ${job.company} - ${job.role}...`}
            size="lg"
          />
        ) : contacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
            <svg className="h-10 w-10 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <div>
              <p className="text-sm font-medium text-gray-700">No contacts found</p>
              <p className="text-xs text-gray-400 mt-1">Try a different company or role.</p>
            </div>
            <button
              onClick={onBack}
              className="text-xs text-indigo-600 font-medium hover:text-indigo-700"
            >
              Try another search
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-gray-500">
              {contacts.length} contact{contacts.length !== 1 ? 's' : ''} found - ranked by relevance
            </p>
            {contacts.map((contact) => (
              <ContactCard key={contact.id} contact={contact} onDraft={onDraft} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
