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
  experience: Array<{
    company: string;
    title: string;
    start: string;
    end: string;
    description: string;
  }>;
  skills: string[];
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

export type Screen =
  | 'onboarding'
  | 'main'
  | 'contacts'
  | 'draft'
  | 'tracking';
