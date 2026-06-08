const API_BASE = 'http://localhost:3001';

// Must match the key the popup writes to in lib/storage.ts (TOKEN_KEY).
// Previously read 'token', which never matched, so the Apply auto-draft never authed.
const TOKEN_KEY = 'warmpath_token';

async function getStoredToken(): Promise<string | null> {
  const result = await chrome.storage.local.get(TOKEN_KEY);
  return result[TOKEN_KEY] ?? null;
}

// Shape returned by GET /profile (the resume-parsed JSON, sent unwrapped by the backend).
// Must satisfy the /draft route's user_profile schema, so we fall back to a valid empty
// profile when the user hasn't uploaded a resume yet (otherwise /draft 400s).
interface UserProfile {
  experience: Array<{ company: string; title: string; start: string; end: string; description: string }>;
  skills: string[];
  school: string;
  grad_year: number;
}

const EMPTY_PROFILE: UserProfile = { experience: [], skills: [], school: '', grad_year: 0 };

// Shape of each item in the /resolve response: { contacts: [{ contact, email_resolution }] }
interface ResolvedContact {
  contact: {
    id: string;
    full_name: string;
    first_name: string;
    last_name: string;
    title: string;
    persona: string;
    school_match: boolean;
    linkedin_url: string;
    company_domain: string;
  };
  email_resolution: {
    id: string;
    email: string;
    status: string;
    tier: string;
    source: string;
    pattern_used: string;
  };
}

async function resolveAndDraft(title: string, company: string, url: string, token: string) {
  // Fetch the user's profile first so we can (a) feed their school into contact
  // resolution for alumni matches and (b) ground the drafts. The backend returns the
  // parsed JSON unwrapped, and 404s when no resume has been uploaded yet.
  const profileRes = await fetch(`${API_BASE}/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const userProfile: UserProfile = profileRes.ok ? await profileRes.json() : EMPTY_PROFILE;

  // Resolve contacts
  const resolveRes = await fetch(`${API_BASE}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      company,
      role: title,
      domain: company.toLowerCase().replace(/\s+/g, '') + '.com',
      ...(userProfile.school ? { user_school: userProfile.school } : {}),
    }),
  });
  if (!resolveRes.ok) throw new Error('resolve failed');
  const { contacts }: { contacts: ResolvedContact[] } = await resolveRes.json();

  // Draft for the top 2 verified/likely contacts (tier lives on email_resolution).
  const top = (contacts ?? [])
    .filter(c => c.email_resolution.tier === 'green' || c.email_resolution.tier === 'amber')
    .slice(0, 2);
  if (top.length === 0) return [];

  const drafts = await Promise.all(top.map(async ({ contact, email_resolution }) => {
    const draftRes = await fetch(`${API_BASE}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        contact: {
          full_name: contact.full_name,
          title: contact.title,
          persona: contact.persona,
          company,
          school_match: contact.school_match,
          linkedin_url: contact.linkedin_url,
        },
        role: title,
        company,
        user_profile: userProfile,
      }),
    });
    if (!draftRes.ok) return null;
    const draft = await draftRes.json();
    return {
      contact: { ...contact, email: email_resolution.email, tier: email_resolution.tier },
      draft,
      job: { company, role: title, url },
    };
  }));

  return drafts.filter(Boolean);
}

export default defineBackground(() => {
  let lastDetectedJob: { title: string; company: string; url: string } | null = null;

  chrome.storage.session.get('lastDetectedJob').then((result) => {
    if (result.lastDetectedJob) lastDetectedJob = result.lastDetectedJob;
  }).catch(() => {});

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'JOB_DETECTED') {
      lastDetectedJob = message.payload;
      chrome.storage.session.set({ lastDetectedJob }).catch(() => {});
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
      chrome.runtime.sendMessage(message).catch(() => {});
    }

    if (message.type === 'GET_LAST_JOB') {
      sendResponse({ job: lastDetectedJob });
      return true;
    }

    if (message.type === 'CLEAR_JOB_BADGE') {
      chrome.action.setBadgeText({ text: '' });
      lastDetectedJob = null;
      chrome.storage.session.remove('lastDetectedJob').catch(() => {});
    }

    if (message.type === 'GET_PENDING_DRAFTS') {
      chrome.storage.session.get('pendingDrafts').then((r) => {
        sendResponse({ drafts: r.pendingDrafts ?? [] });
      });
      return true;
    }

    if (message.type === 'CLEAR_PENDING_DRAFTS') {
      chrome.storage.session.remove('pendingDrafts').catch(() => {});
      chrome.action.setBadgeText({ text: '' });
    }

    if (message.type === 'JOB_APPROVED') {
      const { title, company, url } = message.payload;
      getStoredToken().then(async (token) => {
        if (!token) return;
        try {
          const drafts = await resolveAndDraft(title, company, url, token);
          if (drafts.length > 0) {
            await chrome.storage.session.set({ pendingDrafts: drafts });
            chrome.action.setBadgeText({ text: `${drafts.length}` });
            chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
            // Notify popup if open
            chrome.runtime.sendMessage({ type: 'DRAFTS_READY', payload: { count: drafts.length } }).catch(() => {});
          }
        } catch {
          // silently fail - user can still use the popup manually
        }
      });
    }

    return true;
  });
});
