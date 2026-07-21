// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '../lib/api';
import type { Contact, Draft, JobContext, OutreachEvent, Profile } from '../lib/types';
import DraftEditor from './DraftEditor';
import MainScreen from './MainScreen';
import OnboardingScreen from './OnboardingScreen';
import TrackingDashboard from './TrackingDashboard';

vi.mock('../lib/api', () => ({
  createSession: vi.fn(),
  generateDraft: vi.fn(),
  getEvents: vi.fn(),
  requestCode: vi.fn(),
  resolveContacts: vi.fn(),
  trackEvent: vi.fn(),
  uploadProfile: vi.fn(),
  verifyCode: vi.fn(),
}));

vi.mock('../lib/storage', () => ({
  setProfile: vi.fn(),
  setToken: vi.fn(),
}));

const profile: Profile = {
  experience: [],
  skills: ['TypeScript'],
  school: 'USC',
  grad_year: 2027,
};

const contact: Contact = {
  id: 'contact-1',
  full_name: 'Marcus Lee',
  title: 'Software Engineer',
  persona: 'alumni',
  company_domain: 'figma.com',
  school_match: true,
  email: 'marcus@figma.com',
  tier: 'green',
  status: 'verified',
};

const job: JobContext = {
  company: 'Figma',
  role: 'Software Engineer Intern',
  url: 'https://jobs.lever.co/figma/123',
};

const draft: Draft = {
  subject: 'USC student interested in Figma',
  body: 'Hi Marcus, I would value your perspective on the team.',
  word_count: 10,
  warnings: [],
};

const mainProps = {
  token: 'token',
  onContactsFound: vi.fn(),
  onViewTracking: vi.fn(),
  onViewAutofillSetup: vi.fn(),
  onLogout: vi.fn(),
};

let tabsCreateMock: ReturnType<typeof vi.fn>;
let tabsQueryMock: ReturnType<typeof vi.fn>;

describe('redesigned popup workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getEvents).mockResolvedValue([]);
    vi.mocked(api.resolveContacts).mockResolvedValue([]);
    vi.mocked(api.trackEvent).mockResolvedValue(undefined);
    tabsCreateMock = vi.fn().mockResolvedValue({ id: 7 });
    tabsQueryMock = vi.fn().mockResolvedValue([{ id: 7 }]);
    vi.stubGlobal('chrome', {
      tabs: {
        create: tabsCreateMock,
        query: tabsQueryMock,
      },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([]),
      },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('preserves a manually edited job when asynchronous detection arrives', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<MainScreen {...mainProps} detectedJob={null} />);

    const companyInput = screen.getByLabelText('Company') as HTMLInputElement;
    await user.type(companyInput, 'Manual Company');

    rerender(<MainScreen {...mainProps} detectedJob={job} />);

    expect((screen.getByLabelText('Company') as HTMLInputElement).value).toBe('Manual Company');
    expect((screen.getByLabelText('Role') as HTMLInputElement).value).toBe(job.role);
  });

  it('shows a recent outreach API failure instead of an empty-state lie', async () => {
    vi.mocked(api.getEvents).mockRejectedValueOnce(new Error('Session expired'));
    render(<MainScreen {...mainProps} detectedJob={job} />);

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Session expired');
  });

  it('validates the manual job form before resolving contacts', async () => {
    const user = userEvent.setup();
    render(<MainScreen {...mainProps} detectedJob={null} />);

    await user.click(screen.getByRole('button', { name: 'Find contacts' }));

    expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Enter both the company and role.');
    expect(api.resolveContacts).not.toHaveBeenCalled();
  });

  it('submits the detected job through contact resolution', async () => {
    const user = userEvent.setup();
    const onContactsFound = vi.fn();
    vi.mocked(api.resolveContacts).mockResolvedValueOnce([contact]);
    render(<MainScreen {...mainProps} detectedJob={job} onContactsFound={onContactsFound} />);

    await user.click(screen.getByRole('button', { name: 'Find contacts' }));

    await waitFor(() => {
      expect(api.resolveContacts).toHaveBeenCalledWith('token', {
        company: job.company,
        role: job.role,
        user_school: undefined,
      });
      expect(onContactsFound).toHaveBeenCalledWith([contact], job);
    });
  });

  it('shows a restricted-page error when Chrome exposes no current tab', async () => {
    const user = userEvent.setup();
    tabsQueryMock.mockResolvedValueOnce([]);
    render(<MainScreen {...mainProps} detectedJob={job} />);

    await user.click(screen.getByRole('button', { name: 'Fill page' }));

    expect(await screen.findByText('Could not find the current tab.')).toBeTruthy();
  });

  it('reports Gmail launch failures and does not show false success', async () => {
    const user = userEvent.setup();
    tabsCreateMock.mockRejectedValueOnce(new Error('Tabs unavailable'));

    render(
      <DraftEditor
        contact={contact}
        job={job}
        token="token"
        profile={profile}
        onBack={vi.fn()}
        onDraftAnother={vi.fn()}
        prebuiltDraft={draft}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Open in Gmail' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Tabs unavailable');
    expect(screen.queryByRole('button', { name: 'Opened Gmail' })).toBeNull();
  });

  it('uses prebuilt drafts without regenerating and copies the reviewed content', async () => {
    render(
      <DraftEditor
        contact={contact}
        job={job}
        token="token"
        profile={profile}
        onBack={vi.fn()}
        onDraftAnother={vi.fn()}
        prebuiltDraft={draft}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Copy' }));

    expect(api.generateDraft).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`Subject: ${draft.subject}\n\n${draft.body}`);
      expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    });
  });

  it('logs the reviewed email as sent with the final edited content', async () => {
    const user = userEvent.setup();
    render(
      <DraftEditor
        contact={contact}
        job={job}
        token="token"
        profile={profile}
        onBack={vi.fn()}
        onDraftAnother={vi.fn()}
        prebuiltDraft={draft}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Mark as sent' }));

    await waitFor(() => {
      expect(api.trackEvent).toHaveBeenCalledWith('token', {
        contact_id: contact.id,
        channel: 'email',
        subject: draft.subject,
        draft_text: draft.body,
        outcome: 'sent',
      });
      expect(screen.getByText('Logged as sent')).toBeTruthy();
    });
  });

  it('renders an unknown outreach status with the neutral fallback', async () => {
    const unknownStatusEvent = {
      id: 'event-1',
      contact,
      channel: 'email',
      bounced: false,
      status: 'queued',
    } as unknown as OutreachEvent;
    vi.mocked(api.getEvents).mockResolvedValueOnce([unknownStatusEvent]);

    render(<TrackingDashboard token="token" onBack={vi.fn()} />);

    expect(await screen.findByText('queued')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Outreach' })).toBeTruthy();
  });

  it('updates a sent outreach event to replied', async () => {
    const user = userEvent.setup();
    const sentEvent: OutreachEvent = {
      id: 'event-2',
      contact,
      channel: 'email',
      bounced: false,
      status: 'sent',
    };
    vi.mocked(api.getEvents).mockResolvedValueOnce([sentEvent]);
    render(<TrackingDashboard token="token" onBack={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Mark replied' }));

    await waitFor(() => {
      expect(api.trackEvent).toHaveBeenCalledWith('token', {
        contact_id: contact.id,
        channel: 'email',
        outcome: 'replied',
      });
      expect(screen.getByText('replied')).toBeTruthy();
    });
  });

  it('keeps a failed outreach status update recoverable', async () => {
    const user = userEvent.setup();
    const sentEvent: OutreachEvent = {
      id: 'event-3',
      contact,
      channel: 'email',
      bounced: false,
      status: 'sent',
    };
    vi.mocked(api.getEvents).mockResolvedValueOnce([sentEvent]);
    vi.mocked(api.trackEvent).mockRejectedValueOnce(new Error('Update failed'));
    render(<TrackingDashboard token="token" onBack={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Mark bounced' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Update failed');
    expect(screen.getByText('sent')).toBeTruthy();
  });

  it('keeps onboarding validation visible and rejects non-PDF uploads', async () => {
    const user = userEvent.setup();
    render(<OnboardingScreen onComplete={vi.fn()} />);

    await user.type(screen.getByLabelText('Email address'), 'student@usc.edu');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Add your resume PDF.');

    fireEvent.change(screen.getByLabelText(/Choose your resume/), {
      target: { files: [new File(['resume'], 'resume.txt', { type: 'text/plain' })] },
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveProperty('textContent', 'Upload your resume as a PDF.');
    });
  });

  it('moves a valid PDF signup into email verification', async () => {
    const user = userEvent.setup();
    vi.mocked(api.requestCode).mockResolvedValueOnce({ sent: true });
    render(<OnboardingScreen onComplete={vi.fn()} />);

    await user.type(screen.getByLabelText('Email address'), 'student@usc.edu');
    fireEvent.change(screen.getByLabelText(/Choose your resume/), {
      target: { files: [new File(['pdf'], 'resume.pdf', { type: 'application/pdf' })] },
    });
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeTruthy();
    expect(api.requestCode).toHaveBeenCalledWith('student@usc.edu');
  });

  it('uses the session fallback when email verification is unavailable', async () => {
    const user = userEvent.setup();
    const onComplete = vi.fn();
    vi.mocked(api.requestCode).mockRejectedValueOnce(new Error('503 verification_unavailable'));
    vi.mocked(api.createSession).mockResolvedValueOnce({ token: 'fallback-token' });
    vi.mocked(api.uploadProfile).mockResolvedValueOnce(profile);
    render(<OnboardingScreen onComplete={onComplete} />);

    await user.type(screen.getByLabelText('Email address'), 'student@usc.edu');
    fireEvent.change(screen.getByLabelText(/Choose your resume/), {
      target: { files: [new File(['pdf'], 'resume.pdf', { type: 'application/pdf' })] },
    });
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => {
      expect(api.createSession).toHaveBeenCalledWith('student@usc.edu');
      expect(api.uploadProfile).toHaveBeenCalledWith('fallback-token', expect.any(File));
      expect(onComplete).toHaveBeenCalledWith(profile, 'fallback-token');
    });
  });
});
