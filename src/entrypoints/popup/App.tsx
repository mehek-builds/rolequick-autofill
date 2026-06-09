import React, { useState, useEffect } from 'react';
import { getToken, getProfile, clearAll } from '../../lib/storage';
import type { Contact, JobContext, Profile, Screen } from '../../lib/types';
import OnboardingScreen from '../../components/OnboardingScreen';
import MainScreen from '../../components/MainScreen';
import ContactList from '../../components/ContactList';
import DraftEditor from '../../components/DraftEditor';
import TrackingDashboard from '../../components/TrackingDashboard';
import LoadingSpinner from '../../components/LoadingSpinner';

export default function App() {
  const [screen, setScreen] = useState<Screen>('onboarding');
  const [token, setToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null);
  const [job, setJob] = useState<JobContext | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingDraftCount, setPendingDraftCount] = useState(0);

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
      if (response?.drafts?.length) setPendingDraftCount(response.drafts.length);
    });
    chrome.runtime.sendMessage({ type: 'CLEAR_JOB_BADGE' });
  }, [screen]);

  // Listen for drafts ready while popup is open
  useEffect(() => {
    const handler = (message: { type: string; payload?: { count: number } }) => {
      if (message.type === 'DRAFTS_READY') setPendingDraftCount(message.payload?.count ?? 1);
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
    setScreen('main');
  };

  const handleContactsFound = (found: Contact[], jobCtx: JobContext) => {
    setContacts(found);
    setJob(jobCtx);
    setScreen('contacts');
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
      <div className="w-[380px] min-h-[200px] flex items-center justify-center bg-white font-sans">
        <LoadingSpinner size="md" />
      </div>
    );
  }

  return (
    <div className="w-[380px] max-h-[580px] overflow-y-auto bg-white flex flex-col font-sans text-gray-900 antialiased">
      {screen === 'onboarding' && (
        <OnboardingScreen onComplete={handleOnboardingComplete} />
      )}

      {screen === 'main' && token && profile && (
        <MainScreen
          token={token}
          detectedJob={job}
          pendingDraftCount={pendingDraftCount}
          onDraftsCleared={() => {
            setPendingDraftCount(0);
            chrome.runtime.sendMessage({ type: 'CLEAR_PENDING_DRAFTS' });
          }}
          onContactsFound={handleContactsFound}
          onViewTracking={() => setScreen('tracking')}
          onLogout={handleLogout}
          userSchool={profile.school}
        />
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
