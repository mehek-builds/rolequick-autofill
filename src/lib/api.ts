import type {
  Contact,
  Draft,
  OutreachEvent,
  Profile,
  Outcome,
  Channel,
} from './types';

// Set VITE_API_BASE at build time (e.g. your Vercel URL) to point the extension at the
// deployed backend; defaults to the local dev server.
const BASE_URL = import.meta.env.VITE_API_BASE || 'http://localhost:3001';

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

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API error ${res.status}: ${text}`);
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

  const res = await fetch(`${BASE_URL}/profile`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API error ${res.status}: ${text}`);
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
  const { contacts } = await request<{ contacts: ResolveResponseItem[] }>(
    '/resolve',
    {
      method: 'POST',
      body: JSON.stringify(params),
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
