export type Tier = 'green' | 'amber' | 'blue';
export type Persona = 'alumni' | 'near_peer' | 'senior_ic' | 'hiring_manager' | 'recruiter';
export type Outcome = 'sent' | 'opened' | 'replied' | 'bounced';
export type Channel = 'email' | 'linkedin';
export type ContactStatus = 'verified' | 'likely' | 'linkedin_only' | 'none';
export type OutreachStatus = 'drafted' | 'sent' | 'replied' | 'bounced';

export interface Contact {
  id: string;
  full_name: string;
  title: string;
  persona: Persona;
  company_domain: string;
  school_match: boolean;
  linkedin_url?: string;
  email?: string;
  tier: Tier;
  status: ContactStatus;
}

export interface Draft {
  subject: string;
  body: string;
  word_count: number;
  warnings: string[];
}

export interface OutreachEvent {
  id: string;
  contact: Contact;
  channel: Channel;
  subject?: string;
  sent_at?: string;
  replied_at?: string;
  bounced: boolean;
  status: OutreachStatus;
}

// Matches the parsed-resume JSON returned by POST/GET /profile (backend ParsedProfile),
// which is also the exact shape the /draft route expects as user_profile.
export interface Profile {
  full_name?: string;
  email?: string; // account login email, added server-side by GET /profile - not resume-parsed
  experience: Array<{
    company: string;
    title: string;
    start: string;
    end: string;
    description: string;
  }>;
  skills: string[];
  projects?: Array<{ name: string; description: string }>;
  school: string;
  grad_year: number;
  target_roles?: string[];
  voice_pref?: string;
}

export interface JobContext {
  company: string;
  role: string;
  domain?: string;
  team?: string;
  url?: string;
}

// One background-built draft, as stored in chrome.storage.session by the Apply
// auto-draft flow (background.ts resolveAndDraft). The popup reads these to show
// pre-built drafts without re-generating them.
export interface PendingDraft {
  contact: Contact;
  draft: Draft;
  job: JobContext;
}

export type Screen =
  | 'onboarding'
  | 'main'
  | 'contacts'
  | 'draft'
  | 'tracking'
  | 'autofill-setup';

// ─── v2: resume-gen + application autofill (PRD-v2-resume-autofill.md) ─────────────

export interface ExperienceBankEntry {
  id?: string;
  type: 'job' | 'project';
  org: string;
  title?: string;
  date_range?: string;
  bullet_variants: string[];
  tags?: string[];
}

// Section 4B / Section 8 of PRD-v2. Never included in a drafting-LLM prompt.
export interface ApplicationProfile {
  phone?: string;
  address_city?: string;
  address_state?: string;
  address_zip?: string;
  address_country?: string; // country the student is BASED IN (residence), distinct from citizenship
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
  citizenship?: string;
  work_authorized?: boolean;
  needs_sponsorship?: boolean;
  availability_date?: string;
  desired_salary?: string;
  date_of_birth?: string;
  eeo_prefs?: Record<string, string> | null;
  referral_source_default?: string;
}

export interface ResumeContact {
  full_name: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
}

export interface GeneratedResume {
  resume_url: string;
  file_name: string;
  spec: unknown;
}

// Per-ATS field-mapping adapter contract (Section 7 of PRD-v2). Each adapter fills what it
// can from the application profile + generated resume, skips what it's told never to touch,
// and always stops before Submit - the extension never clicks it.
export interface AutofillResult {
  ats_name: string;
  fields_filled: number;
  fields_skipped: number;
  skipped_reasons: string[];
}
