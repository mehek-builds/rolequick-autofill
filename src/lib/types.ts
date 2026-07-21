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
  degree?: string;
  grad_date?: string;
  grad_year: number;
  currently_enrolled?: boolean;
  coursework?: string[];
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
  type: 'job' | 'project' | 'leadership';
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
  // WHEN she can start. Store ISO YYYY-MM-DD: a locale-shaped string ("18/07/2026") is silently
  // dropped by an MM/DD/YYYY picker (R-014). Adapters format it at write time via shared/dates.
  availability_date?: string;
  // HOW LONG she is available ("14 weeks"), a separate question from when she can start. These
  // were one opaque string, so Espa's "Length or term/length of availability (10-14 weeks)" got
  // answered "Immediately" - a start time in answer to a duration. Not blocking, but it reads as
  // a careless application, which is the exact opposite of the product's promise.
  availability_term?: string;
  desired_salary?: string;
  // The currency desired_salary is denominated in (ISO code, "EUR"). The pair is R-031's gate: a
  // bare figure without its currency is an ambiguity, not an answer, and it only fills when the
  // POSTING's currency is detectable and matches this one (see adapters/salary.ts). Never used to
  // convert; a converted figure is a number the student never said.
  desired_salary_currency?: string;
  date_of_birth?: string;
  eeo_prefs?: Record<string, string> | null;
  referral_source_default?: string;
  // Academic record (R-005). gpa and gpa_scale are SEPARATE deliberately: "3.89" is meaningless
  // without "4.0", and a form asking for a UK percentage cannot be answered honestly without
  // knowing the scale the number was earned on. Never store a pre-converted value here - the
  // conversion belongs to the form being filled, not to the profile.
  gpa?: string; // as earned, e.g. "3.89"
  gpa_scale?: string; // e.g. "4.0"
  major?: string; // e.g. "Computer Science"
  // Languages the student DECLARED fluent, as plain language names (e.g. ["English", "Hindi",
  // "Arabic", "French"]). Served by the backend's applicationProfile. This list is the ONLY
  // authority for language-proficiency questions: never infer a language from the resume, the JD,
  // citizenship, or the country of residence. That is R-015's lesson re-applied - the resume's
  // SKILLS line lifted JD keywords as if they were hers, and a language "inferred" from adjacent
  // data is the same fabrication as a spoken claim on a legal-adjacent screening question. An
  // empty or absent list means every language question is always-ask, never guessed.
  languages?: string[];
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
  resume_id: string;
  resume_url: string;
  file_name: string;
  spec: unknown;
  quality: ResumeQuality;
}

export interface ResumeQuality {
  ready_to_attach: boolean;
  issues: string[];
  warnings: Array<{ entry: string; bullet: string; flags: string[] }>;
  ats_keyword_coverage_pct: number;
  trimmed_for_one_page_fit: boolean;
  sparse_add_more_experience: boolean;
  grounding_removed: string[];
  omissions: string[];
}

// Per-ATS field-mapping adapter contract (Section 7 of PRD-v2). Each adapter fills what it
// can from the application profile + generated resume, skips what it's told never to touch,
// and always stops before Submit - the extension never clicks it.
export interface AutofillResult {
  ats_name: string;
  fields_filled: number;
  fields_skipped: number;
  // How many open-ended answers the adapter AI-drafted this run. Surfaced so content.ts can hold
  // auto-submit whenever anything was drafted: an AI answer must be read by the student before it
  // goes out in their name, and a text match on skipped_reasons is too easy to drift from.
  ai_drafted: number;
  skipped_reasons: string[];
}
