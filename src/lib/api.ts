import type {
  Contact,
  Draft,
  OutreachEvent,
  Profile,
  Outcome,
  Channel,
  ExperienceBankEntry,
  ApplicationProfile,
  ResumeContact,
  GeneratedResume,
} from './types';
import { API_BASE } from './config';


// Throw the backend's human-readable message (quota, rate limit, bad code, etc.)
// when present; raw status-prefixed text otherwise.
async function throwApiError(res: Response): Promise<never> {
  const text = await res.text().catch(() => res.statusText);
  try {
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) throw new Error(parsed.error);
  } catch (e) {
    if (e instanceof Error && !(e instanceof SyntaxError)) throw e;
  }
  throw new Error(`API error ${res.status}: ${text}`);
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    await throwApiError(res);
  }

  return res.json() as Promise<T>;
}

export async function createSession(email: string): Promise<{ token: string }> {
  return request<{ token: string }>('/auth/session', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

// Step 1 of verified signup. Throws "API error 503: ...verification_unavailable..."
// while the backend has no email provider configured; callers fall back to createSession.
export async function requestCode(email: string): Promise<{ sent: boolean }> {
  return request<{ sent: boolean }>('/auth/request-code', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export async function verifyCode(email: string, code: string): Promise<{ token: string }> {
  return request<{ token: string }>('/auth/verify-code', {
    method: 'POST',
    body: JSON.stringify({ email, code }),
  });
}

export async function uploadProfile(
  token: string,
  file: File,
  voice_pref?: string,
): Promise<Profile> {
  const form = new FormData();
  form.append('resume', file);
  if (voice_pref) form.append('voice_pref', voice_pref);

  const res = await fetch(`${API_BASE}/profile`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!res.ok) {
    await throwApiError(res);
  }

  return res.json() as Promise<Profile>;
}

export async function getProfile(token: string): Promise<Profile> {
  return request<Profile>('/profile', {}, token);
}

export interface ResolveParams {
  company: string;
  domain?: string;
  role: string;
  team?: string;
  user_school?: string;
}

// Backend /resolve returns { contacts: [{ contact, email_resolution }] }.
// Flatten each item into the UI's Contact shape (email/tier/status live on email_resolution).
interface ResolveResponseItem {
  contact: {
    id: string;
    full_name: string;
    title: string;
    persona: Contact['persona'];
    school_match: boolean;
    linkedin_url: string;
    company_domain: string;
  };
  email_resolution: {
    email: string;
    status: Contact['status'];
    tier: Contact['tier'];
  };
}

export async function resolveContacts(
  token: string,
  params: ResolveParams,
): Promise<Contact[]> {
  // The backend's /resolve schema requires a non-empty `domain`. When the caller
  // (e.g. the manual "Find my people" form) only has a company name, derive the
  // same best-guess domain the background auto-draft path uses, so both flows hit
  // an identical contract instead of 400-ing on "Invalid request body".
  const domain =
    params.domain && params.domain.trim()
      ? params.domain
      : params.company.toLowerCase().replace(/\s+/g, '') + '.com';

  const { contacts } = await request<{ contacts: ResolveResponseItem[] }>(
    '/resolve',
    {
      method: 'POST',
      body: JSON.stringify({ ...params, domain }),
    },
    token,
  );

  return (contacts ?? []).map(({ contact, email_resolution }) => ({
    id: contact.id,
    full_name: contact.full_name,
    title: contact.title,
    persona: contact.persona,
    company_domain: contact.company_domain,
    school_match: contact.school_match,
    linkedin_url: contact.linkedin_url,
    email: email_resolution.email,
    tier: email_resolution.tier,
    status: email_resolution.status,
  }));
}

export interface GenerateDraftParams {
  contact: Contact;
  role: string;
  company: string;
  user_profile: Profile;
}

export async function generateDraft(
  token: string,
  params: GenerateDraftParams,
): Promise<Draft> {
  return request<Draft>(
    '/draft',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
    token,
  );
}

export interface TrackEventParams {
  contact_id: string;
  channel: Channel;
  subject?: string;
  draft_text?: string;
  outcome: Outcome;
}

export async function trackEvent(
  token: string,
  params: TrackEventParams,
): Promise<void> {
  await request<void>(
    '/track/event',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
    token,
  );
}

export async function getEvents(token: string): Promise<OutreachEvent[]> {
  return request<OutreachEvent[]>('/track/events', {}, token);
}

// ─── v2: experience bank + application profile + resume generation ─────────────

export async function getExperienceBank(token: string): Promise<ExperienceBankEntry[]> {
  const { entries } = await request<{ entries: ExperienceBankEntry[] }>('/profile/experience-bank', {}, token);
  return entries;
}

export async function putExperienceBank(
  token: string,
  entries: ExperienceBankEntry[],
): Promise<ExperienceBankEntry[]> {
  const res = await request<{ entries: ExperienceBankEntry[] }>(
    '/profile/experience-bank',
    { method: 'PUT', body: JSON.stringify({ entries }) },
    token,
  );
  return res.entries;
}

// Throws "API error 404: ..." when the student hasn't completed the application-profile
// step of onboarding yet - callers should treat that as "onboarding incomplete", not a bug.
export async function getApplicationProfile(token: string): Promise<ApplicationProfile> {
  return request<ApplicationProfile>('/profile/application', {}, token);
}

export async function putApplicationProfile(
  token: string,
  profile: ApplicationProfile,
): Promise<ApplicationProfile> {
  return request<ApplicationProfile>(
    '/profile/application',
    { method: 'PUT', body: JSON.stringify(profile) },
    token,
  );
}

export interface GenerateResumeParams {
  company: string;
  role: string;
  jd_text: string;
  contact: ResumeContact;
}

export async function generateResume(
  token: string,
  params: GenerateResumeParams,
): Promise<GeneratedResume> {
  return request<GeneratedResume>(
    '/resume/generate',
    { method: 'POST', body: JSON.stringify(params) },
    token,
  );
}
