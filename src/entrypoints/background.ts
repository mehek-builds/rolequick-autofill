// Token access goes through lib/storage, so the background reads the exact key the popup
// writes, including the backward-compatible fallback to the legacy Volley-era key name.
import { getToken as getStoredToken, migrateLegacyStorage } from '../lib/storage';

// Set VITE_API_BASE at build time (e.g. your Vercel URL) to point at the deployed backend;
// defaults to the local dev server.
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';

// A hung backend must never leave the caller waiting forever - the resume-fill card awaits
// these responses, so an unbounded fetch strands the student on "Tailoring your resume...".
// Resume generation is a real LLM round trip (tens of seconds), so it gets a longer budget
// than the plain JSON endpoints.
const FETCH_TIMEOUT_MS = 20000;
const RESUME_FETCH_TIMEOUT_MS = 60000;
function timeoutFetch(input: string, init: RequestInit = {}, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(ms) });
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
  const profileRes = await timeoutFetch(`${API_BASE}/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const userProfile: UserProfile = profileRes.ok ? await profileRes.json() : EMPTY_PROFILE;

  // Resolve contacts
  const resolveRes = await timeoutFetch(`${API_BASE}/resolve`, {
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

  // We verify all sourced contacts but only draft the best two. For a student, reply
  // likelihood (and referral value) matters more than seniority: alumni and near-peers
  // reply far more than busy execs, so a Head of Eng is a poor cold-email target. Rank by
  // that priority and force the two picks to be DIFFERENT personas (e.g. a near-peer for the
  // referral + a recruiter who owns the req), rather than two of whatever sorts first.
  const DRAFT_PRIORITY = ['alumni', 'near_peer', 'recruiter', 'hiring_manager', 'senior_ic'];
  const rank = (persona: string) => {
    const i = DRAFT_PRIORITY.indexOf(persona);
    return i === -1 ? 99 : i;
  };

  const reachable = (contacts ?? [])
    .filter(c => c.email_resolution.tier === 'green' || c.email_resolution.tier === 'amber')
    .sort((a, b) => rank(a.contact.persona) - rank(b.contact.persona));
  if (reachable.length === 0) return [];

  const top = [reachable[0]];
  const second =
    reachable.find(c => c.contact.persona !== reachable[0].contact.persona) ?? reachable[1];
  if (second) top.push(second);

  const drafts = await Promise.all(top.map(async ({ contact, email_resolution }) => {
    const draftRes = await timeoutFetch(`${API_BASE}/draft`, {
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

interface ApplicationProfileResponse {
  phone?: string;
  address_city?: string;
  address_state?: string;
  address_zip?: string;
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
  citizenship?: string;
  work_authorized?: boolean;
  needs_sponsorship?: boolean;
  availability_date?: string;
  desired_salary?: string;
  eeo_prefs?: Record<string, string> | null;
  referral_source_default?: string;
}

// Fetches everything a client-side autofill adapter needs in one round trip: the resume
// profile (for name/experience), the more-sensitive application profile (Section 4B - phone,
// address, work-auth), and a JD-tailored resume file. Runs in the background script (not the
// content script) because it needs the auth token from chrome.storage.local.
async function generateResumeAndProfile(
  company: string,
  role: string,
  jdText: string,
  token: string,
) {
  // The two profile fetches are independent, so run them together instead of one-after-another -
  // this is on the pre-warm critical path, so a saved round trip is a saved round trip.
  const [profileRes, appProfileRes] = await Promise.all([
    timeoutFetch(`${API_BASE}/profile`, { headers: { Authorization: `Bearer ${token}` } }),
    timeoutFetch(`${API_BASE}/profile/application`, { headers: { Authorization: `Bearer ${token}` } }),
  ]);
  const profile: UserProfile & { full_name?: string; email?: string } = profileRes.ok ? await profileRes.json() : EMPTY_PROFILE;
  const applicationProfile: ApplicationProfileResponse = appProfileRes.ok ? await appProfileRes.json() : {};

  const resumeRes = await timeoutFetch(`${API_BASE}/resume/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      company,
      role,
      jd_text: jdText,
      contact: {
        full_name: profile.full_name || 'Applicant',
        email: profile.email,
        linkedin_url: applicationProfile.linkedin_url,
        github_url: applicationProfile.github_url,
        portfolio_url: applicationProfile.portfolio_url,
        phone: applicationProfile.phone,
      },
    }),
  }, RESUME_FETCH_TIMEOUT_MS);
  if (!resumeRes.ok) {
    const body: { error?: string; detail?: string[] } | null = await resumeRes.json().catch(() => null);
    const message = body?.detail?.length ? `${body.error}: ${body.detail.join(', ')}` : body?.error;
    throw new Error(message || 'resume generation failed');
  }
  const resume: { resume_url: string; file_name: string; spec: unknown } = await resumeRes.json();

  return { profile, applicationProfile, resume };
}

export default defineBackground(() => {
  // One-time copy of any legacy Volley-era storage keys to their new rolequick_* names, so a
  // published update never orphans an existing user's saved token/profile/settings.
  void migrateLegacyStorage();

  let lastDetectedJob: { title: string; company: string; url: string } | null = null;

  chrome.storage.session.get('lastDetectedJob').then((result) => {
    if (result.lastDetectedJob) lastDetectedJob = result.lastDetectedJob as { title: string; company: string; url: string };
  }).catch(() => {});

  // IMPORTANT: only return true for branches that call sendResponse asynchronously.
  // Returning true from a fire-and-forget handler (or a blanket return at the end) leaves
  // the message channel open with no response coming, which surfaces in the sender (the
  // popup) as "A listener indicated an asynchronous response... but the message channel
  // closed before a response was received" once the popup unmounts.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case 'JOB_DETECTED': {
        // Idempotent: content scripts (notably the Workday stage poll) can re-fire this for the
        // same job repeatedly. Skip the storage write, badge update, and popup broadcast when the
        // payload is unchanged, so a re-detect of the same posting isn't a write/message storm.
        const p = message.payload as { title: string; company: string; url: string };
        const unchanged =
          lastDetectedJob &&
          lastDetectedJob.title === p.title &&
          lastDetectedJob.company === p.company &&
          lastDetectedJob.url === p.url;
        if (unchanged) return false;
        lastDetectedJob = p;
        chrome.storage.session.set({ lastDetectedJob }).catch(() => {});
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
        chrome.runtime.sendMessage(message).catch(() => {});
        return false;
      }

      case 'GET_LAST_JOB': {
        sendResponse({ job: lastDetectedJob }); // synchronous response
        return false;
      }

      case 'CLEAR_JOB_BADGE': {
        chrome.action.setBadgeText({ text: '' });
        lastDetectedJob = null;
        chrome.storage.session.remove('lastDetectedJob').catch(() => {});
        return false;
      }

      case 'GET_PENDING_DRAFTS': {
        chrome.storage.session.get('pendingDrafts').then((r) => {
          sendResponse({ drafts: r.pendingDrafts ?? [] });
        });
        return true; // responding asynchronously - keep the channel open
      }

      case 'CLEAR_PENDING_DRAFTS': {
        chrome.storage.session.remove('pendingDrafts').catch(() => {});
        chrome.action.setBadgeText({ text: '' });
        return false;
      }

      case 'JOB_APPROVED': {
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
        return false;
      }

      case 'GENERATE_RESUME_AND_FILL_DATA': {
        const { company, role, jd_text } = message.payload;
        getStoredToken().then(async (token) => {
          if (!token) {
            sendResponse({ error: 'not signed in' });
            return;
          }
          try {
            const result = await generateResumeAndProfile(company, role, jd_text, token);
            sendResponse(result);
          } catch (err) {
            sendResponse({ error: err instanceof Error ? err.message : 'resume generation failed' });
          }
        });
        return true; // responding asynchronously
      }

      case 'ANSWER_QUESTION': {
        // Drafts one open-ended application answer from the backend. The generic adapter calls
        // this per textarea; the field it fills is flagged for review, so this is a first draft
        // in the student's voice, never a silent final answer.
        const { company, role, jd_text, question } = message.payload;
        getStoredToken().then(async (token) => {
          if (!token) {
            sendResponse({ error: 'not signed in' });
            return;
          }
          try {
            const res = await timeoutFetch(`${API_BASE}/application/answer`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ company, role, jd_text, question }),
            }, RESUME_FETCH_TIMEOUT_MS);
            if (!res.ok) {
              sendResponse({ error: `draft failed (${res.status})` });
              return;
            }
            const data: { answer?: string } = await res.json();
            sendResponse({ answer: data.answer ?? null });
          } catch (err) {
            sendResponse({ error: err instanceof Error ? err.message : 'draft failed' });
          }
        });
        return true; // responding asynchronously
      }

      case 'GET_ACCOUNT_CREATION_DATA': {
        // Lighter than GENERATE_RESUME_AND_FILL_DATA - the Workday signup screen only needs the
        // account email, not a resume, so this skips the /resume/generate call entirely (no
        // point spending a resume-gen quota unit on a step before there's even an application to
        // tailor one for). Password is deliberately not fetched here - the student types their
        // own (2026-07-03 product decision), RoleQuick never touches that field.
        getStoredToken().then(async (token) => {
          if (!token) {
            sendResponse({ error: 'not signed in' });
            return;
          }
          try {
            const profileRes = await timeoutFetch(`${API_BASE}/profile`, { headers: { Authorization: `Bearer ${token}` } });
            const profile: { email?: string } = profileRes.ok ? await profileRes.json() : {};
            sendResponse({ email: profile.email });
          } catch (err) {
            sendResponse({ error: err instanceof Error ? err.message : 'could not load account data' });
          }
        });
        return true;
      }

      case 'AUTOFILL_EVENT': {
        getStoredToken().then((token) => {
          if (!token) return;
          timeoutFetch(`${API_BASE}/autofill/event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(message.payload),
          }).catch(() => {});
        });
        return false;
      }

      default:
        return false;
    }
  });
});
