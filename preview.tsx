import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import './src/styles/globals.css';
import type { Contact, Profile, JobContext } from './src/lib/types';
import OnboardingScreen from './src/components/OnboardingScreen';
import MainScreen from './src/components/MainScreen';
import ContactList from './src/components/ContactList';
import DraftEditor from './src/components/DraftEditor';
import TrackingDashboard from './src/components/TrackingDashboard';

const TOKEN = 'preview-token';

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

function Frame({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontFamily: 'Inter Variable, sans-serif', fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
      <div
        style={{
          width: 380,
          height: 580,
          overflowY: 'auto',
          background: '#fff',
          borderRadius: 14,
          boxShadow: '0 8px 30px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
        }}
      >
        <div className="font-sans text-gray-900 antialiased" style={{ minHeight: '100%', display: 'flex', flexDirection: 'column' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function Preview() {
  return (
    <div style={{ padding: 32, display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'flex-start', background: '#f1f3f7' }}>
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
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
