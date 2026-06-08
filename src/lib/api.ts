import type {
  Contact,
  Draft,
  OutreachEvent,
  Profile,
  Outcome,
  Channel,
} from './types';

const BASE_URL = 'http://localhost:3001';

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

export async function resolveContacts(
  token: string,
  params: ResolveParams,
): Promise<Contact[]> {
  return request<Contact[]>(
    '/resolve',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
    token,
  );
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
