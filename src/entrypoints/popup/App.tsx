import React, { useState, useEffect } from 'react';
import { getToken, getProfile, clearAll } from '../../lib/storage';
import type { Contact, Draft, JobContext, PendingDraft, Profile, Screen, Tier, ContactStatus } from '../../lib/types';
import OnboardingScreen from '../../components/OnboardingScreen';
import MainScreen from '../../components/MainScreen';
import ContactList from '../../components/ContactList';
import DraftEditor from '../../components/DraftEditor';
import TrackingDashboard from '../../components/TrackingDashboard';
import AutofillSetupScreen from '../../components/AutofillSetupScreen';
import LoadingSpinner from '../../components/LoadingSpinner';

// Background-stored contacts omit the UI-only `status` field; derive it from the email tier
// so the pre-built-draft contacts render identically to freshly resolved ones.
function statusFromTier(tier: Tier): ContactStatus {
  return tier === 'green' ? 'verified' : tier === 'amber' ? 'likely' : 'linkedin_only';
}

function normalizeContact(c: Contact): Contact {
  return { ...c, status: c.status ?? statusFromTier(c.tier) };
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('onboarding');
  const [token, setToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [job, setJob] = useState<JobContext | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingDraftCount, setPendingDraftCount] = useState(0);
  const [pendingDrafts, setPendingDrafts] = useState<PendingDraft[]>([]);
  // Pre-built drafts keyed by contact id, consumed by DraftEditor so it shows the
  // background-generated draft instead of re-calling /draft.
  const [prebuiltDrafts, setPrebuiltDrafts] = useState<Record<string, Draft>>({});

  // On popup open: check auth state
  useEffect(() => {
    (async () => {
      try {
        const [storedToken, storedProfile] = await Promise.all([
          getToken(),
          getProfile(),
        ]);
        if (storedToken && storedProfile) {
          setToken(storedToken);
          setProfile(storedProfile);
          setScreen('main');
        } else {
          setScreen('onboarding');
        }
      } catch {
        setScreen('onboarding');
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // On popup open: fetch detected job + pending drafts from background
  useEffect(() => {
    if (screen !== 'main') return;
    chrome.runtime.sendMessage({ type: 'GET_LAST_JOB' }, (response) => {
      if (response?.job) {
        setJob({ company: response.job.company, role: response.job.title, url: response.job.url });
      }
    });
    chrome.runtime.sendMessage({ type: 'GET_PENDING_DRAFTS' }, (response) => {
      if (response?.drafts?.length) {
        setPendingDrafts(response.drafts as PendingDraft[]);
        setPendingDraftCount(response.drafts.length);
      }
    });
    chrome.runtime.sendMessage({ type: 'CLEAR_JOB_BADGE' });
  }, [screen]);

  // Listen for drafts ready while popup is open. The DRAFTS_READY ping only carries a count,
  // so re-fetch the full payload from the background to keep pendingDrafts in sync.
  useEffect(() => {
    const handler = (message: { type: string; payload?: { count: number } }) => {
      if (message.type === 'DRAFTS_READY') {
        setPendingDraftCount(message.payload?.count ?? 1);
        chrome.runtime.sendMessage({ type: 'GET_PENDING_DRAFTS' }, (response) => {
          if (response?.drafts?.length) setPendingDrafts(response.drafts as PendingDraft[]);
        });
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // Also listen for live detections while popup is open
  useEffect(() => {
    const handler = (message: { type: string; payload: { title: string; company: string; url: string } }) => {
      if (message.type === 'JOB_DETECTED' && screen === 'main') {
        setJob({ company: message.payload.company, role: message.payload.title, url: message.payload.url });
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [screen]);

  const handleOnboardingComplete = (newProfile: Profile, newToken: string) => {
    setToken(newToken);
    setProfile(newProfile);
    // Route straight into autofill setup at JOIN time so work-auth, EEO, DOB, salary, and links
    // are collected once, up front - never asked mid-application. That keeps the first (and
    // every) fill instant: the adapter only ever reads stored data or skips, it never prompts.
    setScreen('autofill-setup');
  };

  const handleContactsFound = (found: Contact[], jobCtx: JobContext) => {
    setContacts(found);
    setJob(jobCtx);
    setScreen('contacts');
  };

  // Tapping the "drafts ready" banner: open the contacts list populated with the people the
  // background already drafted for, with each pre-built draft available so opening a contact
  // shows it instantly. Clear the badge but keep the data in React state for this session.
  const handleViewDrafts = () => {
    if (pendingDrafts.length === 0) return;
    setContacts(pendingDrafts.map((pd) => normalizeContact(pd.contact)));
    setJob(pendingDrafts[0].job);
    setPrebuiltDrafts(
      Object.fromEntries(pendingDrafts.map((pd) => [pd.contact.id, pd.draft])),
    );
    setScreen('contacts');
    setPendingDraftCount(0);
    chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_DRAFTS' });
  };

  const handleDraft = (contact: Contact) => {
    setSelectedContact(contact);
    setScreen('draft');
  };

  const handleLogout = async () => {
    await clearAll();
    setToken(null);
    setProfile(null);
    setContacts([]);
    setSelectedContact(null);
    setJob(null);
    setScreen('onboarding');
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[200px] w-[380px] items-center justify-center bg-white font-sans" role="status" aria-label="Loading Litos">
        <LoadingSpinner size="md" />
      </div>
    );
  }

  return (
    <div className="flex h-[580px] w-[380px] flex-col overflow-y-auto bg-white font-sans text-gray-950 antialiased">
      {screen === 'onboarding' && (
        <OnboardingScreen onComplete={handleOnboardingComplete} />
      )}

      {screen === 'main' && token && profile && (
        <MainScreen
          token={token}
          detectedJob={job}
          pendingDraftCount={pendingDraftCount}
          onViewDrafts={handleViewDrafts}
          onContactsFound={handleContactsFound}
          onViewTracking={() => setScreen('tracking')}
          onViewAutofillSetup={() => setScreen('autofill-setup')}
          onLogout={handleLogout}
          userSchool={profile.school}
        />
      )}

      {screen === 'autofill-setup' && token && profile && (
        <AutofillSetupScreen token={token} profile={profile} onBack={() => setScreen('main')} />
      )}

      {screen === 'contacts' && token && job && (
        <ContactList
          contacts={contacts}
          job={job}
          loading={false}
          onDraft={handleDraft}
          onBack={() => setScreen('main')}
        />
      )}

      {screen === 'draft' && token && profile && selectedContact && job && (
        <DraftEditor
          contact={selectedContact}
          job={job}
          token={token}
          profile={profile}
          prebuiltDraft={prebuiltDrafts[selectedContact.id] ?? null}
          onBack={() => setScreen('contacts')}
          onDraftAnother={() => setScreen('contacts')}
        />
      )}

      {screen === 'tracking' && token && (
        <TrackingDashboard
          token={token}
          onBack={() => setScreen('main')}
        />
      )}
    </div>
  );
}
