import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/geist';
import './src/styles/globals.css';
import type { Contact, Profile, JobContext } from './src/lib/types';
import OnboardingScreen from './src/components/OnboardingScreen';
import MainScreen from './src/components/MainScreen';
import ContactList from './src/components/ContactList';
import DraftEditor from './src/components/DraftEditor';
import TrackingDashboard from './src/components/TrackingDashboard';
import AutofillSetupScreen from './src/components/AutofillSetupScreen';
import BrandMark from './src/components/BrandMark';

const TOKEN = 'preview-token';

// The standalone preview runs outside Chrome. Mirror the small callback-based storage surface
// used by the popup so every screen can be reviewed without extension APIs.
if (typeof chrome === 'undefined' || !chrome.storage?.local) {
  const previewStorage: Record<string, unknown> = {};
  Object.assign(globalThis, {
    chrome: {
      storage: {
        local: {
          get(keys: string | string[], callback: (items: Record<string, unknown>) => void) {
            const requested = Array.isArray(keys) ? keys : [keys];
            callback(Object.fromEntries(requested.map((key) => [key, previewStorage[key]])));
          },
          set(items: Record<string, unknown>, callback?: () => void) {
            Object.assign(previewStorage, items);
            callback?.();
          },
          remove(keys: string | string[], callback?: () => void) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete previewStorage[key];
            callback?.();
          },
        },
      },
    },
  });
}

const profile: Profile = {
  experience: [
    { company: 'Campus Labs', title: 'SWE Intern', start: '2025', end: '2025', description: 'Built a React + FastAPI study tool used by 400 students.' },
  ],
  skills: ['React', 'TypeScript', 'Python', 'FastAPI'],
  school: 'University of Southern California',
  grad_year: 2027,
};

const job: JobContext = { company: 'Figma', role: 'Software Engineer Intern', url: 'https://linkedin.com/jobs/view/123' };

const contacts: Contact[] = [
  { id: 'c2', full_name: 'Marcus Lee', title: 'Software Engineer', persona: 'alumni', company_domain: 'figma.com', school_match: true, email: 'marcus.lee@figma.com', tier: 'green', status: 'verified' },
  { id: 'c1', full_name: 'Priya Sharma', title: 'Engineering Recruiter', persona: 'recruiter', company_domain: 'figma.com', school_match: false, email: 'priya@figma.com', tier: 'green', status: 'verified' },
  { id: 'c3', full_name: 'Dana Whitfield', title: 'Hiring Manager, Growth', persona: 'hiring_manager', company_domain: 'figma.com', school_match: false, email: 'dana.w@figma.com', tier: 'amber', status: 'likely' },
  { id: 'c4', full_name: 'Jordan Kim', title: 'New Grad SWE', persona: 'near_peer', company_domain: 'figma.com', school_match: false, linkedin_url: 'linkedin.com/in/jordankim', tier: 'blue', status: 'linkedin_only' },
];

const noop = () => {};

const PREVIEW_COLORS = {
  canvas: '#faf9f7',
  ink: '#151412',
  muted: '#625f5b',
  border: '#d0ccc5',
  accent: '#3157d5',
  surface: '#ffffff',
} as const;

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontFamily: 'Geist Variable, sans-serif', fontSize: 12, fontWeight: 700, color: PREVIEW_COLORS.muted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div
        style={{
          width: 380,
          height: 580,
          overflowY: 'auto',
          background: PREVIEW_COLORS.surface,
          border: `1px solid ${PREVIEW_COLORS.border}`,
          borderRadius: 10,
          boxShadow: '0 8px 24px rgba(35, 33, 29, 0.08)',
        }}
      >
        <div className="font-sans text-gray-900 antialiased" style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

const storeScreens = {
  onboarding: {
    eyebrow: 'SET UP ONCE',
    title: 'Your application workflow, ready when you are.',
    body: 'Add your resume once. Litos uses your real experience to help with applications and thoughtful outreach.',
    screen: <OnboardingScreen onComplete={noop} />,
  },
  main: {
    eyebrow: 'ONE JOB, TWO WORKFLOWS',
    title: 'Apply and reach out from one focused workspace.',
    body: 'Fill the application, find relevant people, and review every draft before it goes anywhere.',
    screen: (
      <MainScreen
        token={TOKEN}
        detectedJob={job}
        pendingDraftCount={2}
        onViewDrafts={noop}
        onContactsFound={noop}
        onViewTracking={noop}
        onViewAutofillSetup={noop}
        onLogout={noop}
        userSchool={profile.school}
      />
    ),
  },
  contacts: {
    eyebrow: 'RELEVANT CONTACTS',
    title: 'Find people worth contacting, without the noise.',
    body: 'Litos prioritizes likely replies and keeps the details you need in one compact, reviewable list.',
    screen: <ContactList contacts={contacts} job={job} loading={false} onDraft={noop} onBack={noop} />,
  },
} as const;

function StorePreview({ screen }: { screen: keyof typeof storeScreens }) {
  const content = storeScreens[screen];

  return (
    <main
      style={{
        boxSizing: 'border-box',
        width: 1280,
        height: 800,
        overflow: 'hidden',
        display: 'grid',
        gridTemplateColumns: '1fr 460px',
        alignItems: 'center',
        gap: 76,
        padding: '72px 120px',
        background: PREVIEW_COLORS.canvas,
        color: PREVIEW_COLORS.ink,
        fontFamily: 'Geist Variable, sans-serif',
      }}
    >
      <section style={{ maxWidth: 530 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 54 }}>
          <span style={{ display: 'grid', placeItems: 'center', width: 38, height: 38, borderRadius: 9, background: PREVIEW_COLORS.accent, color: 'white' }}>
            <BrandMark className="h-5 w-5" />
          </span>
          <span style={{ fontSize: 23, fontWeight: 650, letterSpacing: '-0.02em' }}>Litos</span>
        </div>
        <p style={{ margin: 0, color: PREVIEW_COLORS.accent, fontSize: 14, fontWeight: 700, letterSpacing: '0.1em' }}>{content.eyebrow}</p>
        <h1 style={{ margin: '18px 0 20px', maxWidth: 520, fontSize: 48, lineHeight: 1.08, letterSpacing: '-0.045em', fontWeight: 650 }}>{content.title}</h1>
        <p style={{ margin: 0, maxWidth: 490, color: PREVIEW_COLORS.muted, fontSize: 20, lineHeight: 1.55 }}>{content.body}</p>
      </section>

      <section
        aria-label={`${screen} extension preview`}
        style={{
          width: 380,
          height: 580,
          overflow: 'hidden',
          justifySelf: 'end',
          background: PREVIEW_COLORS.surface,
          border: `1px solid ${PREVIEW_COLORS.border}`,
          borderRadius: 10,
          boxShadow: '0 24px 60px rgba(35, 33, 29, 0.14)',
        }}
      >
        <div className="font-sans text-gray-900 antialiased" style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
          {content.screen}
        </div>
      </section>
    </main>
  );
}

function Preview() {
  return (
    <div style={{ padding: 32, display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start', background: PREVIEW_COLORS.canvas }}>
      <Frame label="1 · Onboarding">
        <OnboardingScreen onComplete={noop} />
      </Frame>

      <Frame label="2 · Main (detected job + recent outreach)">
        <MainScreen
          token={TOKEN}
          detectedJob={job}
          pendingDraftCount={2}
          onViewDrafts={noop}
          onContactsFound={noop}
          onViewTracking={noop}
          onViewAutofillSetup={noop}
          onLogout={noop}
          userSchool={profile.school}
        />
      </Frame>

      <Frame label="3 · Contacts (avatars, dots, badges)">
        <ContactList contacts={contacts} job={job} loading={false} onDraft={noop} onBack={noop} />
      </Frame>

      <Frame label="4 · Draft editor (success states)">
        <DraftEditor contact={contacts[0]} job={job} token={TOKEN} profile={profile} onBack={noop} onDraftAnother={noop} />
      </Frame>

      <Frame label="5 · Tracking dashboard">
        <TrackingDashboard token={TOKEN} onBack={noop} />
      </Frame>

      <Frame label="6 · Contacts (loading skeletons)">
        <ContactList contacts={[]} job={job} loading={true} onDraft={noop} onBack={noop} />
      </Frame>

      <Frame label="7 · Autofill setup (v2, seeded from resume)">
        <AutofillSetupScreen token={TOKEN} profile={profile} onBack={noop} />
      </Frame>
    </div>
  );
}

const storeScreen = new URLSearchParams(window.location.search).get('store') as keyof typeof storeScreens | null;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {storeScreen && storeScreens[storeScreen] ? <StorePreview screen={storeScreen} /> : <Preview />}
  </React.StrictMode>,
);
