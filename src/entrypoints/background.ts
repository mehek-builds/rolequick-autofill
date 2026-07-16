// Token access goes through lib/storage, so the background reads the exact key the popup
// writes, including the backward-compatible fallback to the legacy Volley-era key name.
import { getToken as getStoredToken, migrateLegacyStorage, setToken, setAutoSubmitEnabled } from '../lib/storage';
import { overloadWaitMs, overloadBudgetRemains, RESUME_OVERLOAD_BUDGET_MS } from '../lib/overload';

// Set VITE_API_BASE at build time (e.g. your Vercel URL) to point at the deployed backend;
// defaults to the local dev server.
const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';

// Latched off once the backend reports onboarding complete. Service-worker memory is fine for
// this: the worst case on a restart is one wasted 403, which re-latches it immediately.
let harvestStopped = false;

/**
 * POST what the student typed by hand to /profile/harvest.
 *
 * The server is the authority on every rule that matters here - it refuses work authorization,
 * sponsorship and self-identification with a hard 400, only fills fields that are empty, and 403s
 * once onboarding is done. This function deliberately re-checks none of that: a second copy of
 * those rules in the client is a second thing to drift. Its only job is carrying the token and
 * translating a 403 into "stop asking".
 */
async function harvestFields(fields: unknown): Promise<{ ok: boolean; stop?: boolean; kept?: string[] }> {
  if (harvestStopped) return { ok: false, stop: true };
  const token = await getStoredToken();
  if (!token) return { ok: false };
  try {
    const res = await timeoutFetch(`${API_BASE}/profile/harvest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ fields }),
    });
    if (res.status === 403) {
      harvestStopped = true;
      return { ok: false, stop: true };
    }
    if (!res.ok) {
      // A 400 here means the classifier produced a field the server refuses - i.e. the R-004
      // guard failed somewhere upstream. Loud in the log, because it should be impossible:
      // ProfileKey has no member for any denied field.
      console.warn('[RoleQuick] harvest rejected', res.status, await res.text().catch(() => ''));
      return { ok: false };
    }
    const body = (await res.json().catch(() => null)) as { kept?: string[] } | null;
    return { ok: true, kept: body?.kept ?? [] };
  } catch {
    return { ok: false };
  }
}

// A hung backend must never leave the caller waiting forever - the resume-fill card awaits
// these responses, so an unbounded fetch strands the student on "Tailoring your resume...".
// Resume generation is a real LLM round trip (tens of seconds), so it gets a longer budget
// than the plain JSON endpoints.
const FETCH_TIMEOUT_MS = 20000;
const RESUME_FETCH_TIMEOUT_MS = 60000;
function timeoutFetch(input: string, init: RequestInit = {}, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(ms) });
}

// ─── Transient model-capacity retry (live QA 2026-07-16, R-003) ──────────────
// A real Anthropic overload incident hard-failed a whole fill: the card said "Failed to generate
// resume spec" and the student's only recovery was re-clicking "Yes, fill it" (6+ times on Global
// Relay, never succeeding while it lasted). It blocked a submission outright.
//
// The retry has to live HERE, on the client, and that is not a stylistic choice. The backend cannot
// retry its way out: Vercel kills the function at 60s (vercel.json maxDuration) and the incident
// needed ~6 attempts over ~2.5 minutes to get a 200. Only a FRESH REQUEST escapes that ceiling, so
// only the client can outlive an incident longer than one function. The backend's job is to say
// which failures are worth coming back for; it now returns 503 + `code: 'llm_overloaded'` for
// exactly those, which is what this loop keys on. Anything else still fails fast: retrying a bad JD
// against a healthy API just reproduces the same error more slowly.
//
// 150s covers the observed incident (the manual poll that eventually got a 200 took ~2.5 min).
// The student is never trapped by it: the card stays dismissable throughout and reports each retry,
// and because generation pre-warms on card hover, most or all of this window is usually spent
// before they ever click "Yes, fill it".
//
// Known risk, deliberately accepted: an MV3 service worker can be torn down mid-loop. The pending
// sendResponse port keeps it alive in practice (and this file already awaits a 60s fetch the same
// way), and content.ts already treats a dead worker as a recoverable error and offers a manual fill,
// so the worst case degrades to today's behavior rather than to a hang.
// The wait policy itself lives in lib/overload.ts, where it can be unit-tested: background.ts can't
// be imported by a test (chrome.* and defineBackground at module load), and a silently-wrong
// backoff is exactly the kind of bug that only shows up during the next incident.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  // Called before each capacity backoff so the caller can tell the student what is happening.
  // "Tailoring your resume..." sitting frozen for two minutes is indistinguishable from a hang, and
  // a student who thinks it hung fills the form by hand or re-clicks (which is what the live
  // incident produced). Optional: a caller that has nowhere to show it still gets the retry.
  onOverloadRetry?: (attempt: number, waitMs: number) => void,
) {
  // The two profile fetches are independent, so run them together instead of one-after-another -
  // this is on the pre-warm critical path, so a saved round trip is a saved round trip.
  const [profileRes, appProfileRes] = await Promise.all([
    timeoutFetch(`${API_BASE}/profile`, { headers: { Authorization: `Bearer ${token}` } }),
    timeoutFetch(`${API_BASE}/profile/application`, { headers: { Authorization: `Bearer ${token}` } }),
  ]);
  const profile: UserProfile & { full_name?: string; email?: string } = profileRes.ok ? await profileRes.json() : EMPTY_PROFILE;
  const applicationProfile: ApplicationProfileResponse = appProfileRes.ok ? await appProfileRes.json() : {};

  // Only the resume POST retries. The profile reads above are cheap, already done, and unaffected
  // by a model overload; re-running them per attempt would add round trips to a backend that is
  // already telling us it is busy.
  const overloadDeadline = Date.now() + RESUME_OVERLOAD_BUDGET_MS;
  let resume: { resume_url: string; file_name: string; spec: unknown } | undefined;
  for (let attempt = 1; ; attempt++) {
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

    if (resumeRes.ok) {
      resume = await resumeRes.json();
      break;
    }

    const body: { error?: string; detail?: string[]; code?: string; retry_after_ms?: number } | null =
      await resumeRes.json().catch(() => null);

    // The one retryable case, and it is retryable only because the SERVER said so. Keying on the
    // explicit code rather than the bare 503 matters: the route returns 503 for "taking too long"
    // as well, which is a budget failure that retrying identically would just reproduce.
    const overloaded = resumeRes.status === 503 && body?.code === 'llm_overloaded';
    if (overloaded && overloadBudgetRemains(overloadDeadline)) {
      const waitMs = overloadWaitMs(body?.retry_after_ms);
      onOverloadRetry?.(attempt, waitMs);
      await sleep(waitMs);
      continue;
    }

    const message = body?.detail?.length ? `${body.error}: ${body.detail.join(', ')}` : body?.error;
    if (overloaded) {
      // Budget spent on a still-ongoing incident. Say what actually happened rather than the
      // generic failure: this is a capacity problem that will pass, not a broken resume, and the
      // student should know re-clicking later is worth it.
      throw new Error('The model stayed busy for too long. Try "Yes, fill it" again in a minute, or fill this one manually.');
    }
    throw new Error(message || 'resume generation failed');
  }

  return { profile, applicationProfile, resume };
}

export default defineBackground(() => {
  // One-time copy of any legacy Volley-era storage keys to their new rolequick_* names, so a
  // published update never orphans an existing user's saved token/profile/settings.
  void migrateLegacyStorage();

  // QA/dev bootstrap: when built with VITE_QA_TOKEN, seed the session once at install/reload so
  // the extension is signed in without driving the popup UI (which automation can't reach).
  // Seeding on onInstalled (not on every service-worker wake) means sign-out tests and the
  // auto-submit toggle hold their state for the rest of the QA run. Keeping it out of store
  // builds is enforced by scripts/ensure-no-qa-token.mjs, which the zip scripts run first.
  if (import.meta.env.VITE_QA_TOKEN) {
    chrome.runtime.onInstalled.addListener(() => {
      setToken(import.meta.env.VITE_QA_TOKEN)
        .then(() => setAutoSubmitEnabled(import.meta.env.VITE_QA_AUTOSUBMIT === '1'))
        .catch((e) => console.warn('[RoleQuick QA] storage seed failed:', e));
    });
  }

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
        // The card lives in the sending tab, so a capacity-retry notice has to go back to that tab
        // specifically: chrome.runtime.sendMessage from the background reaches the popup, never a
        // content script (that is why DRAFTS_READY works but this would not). Best-effort by
        // design - a closed tab or a card already dismissed just means nobody is listening, which
        // must never take down the generation itself.
        const tabId = _sender.tab?.id;
        const notifyRetry = (attempt: number, waitMs: number) => {
          if (tabId === undefined) return;
          chrome.tabs
            .sendMessage(tabId, { type: 'RESUME_GEN_RETRYING', payload: { company, role, attempt, waitMs } })
            .catch(() => {});
        };
        getStoredToken().then(async (token) => {
          if (!token) {
            sendResponse({ error: 'not signed in' });
            return;
          }
          try {
            const result = await generateResumeAndProfile(company, role, jd_text, token, notifyRetry);
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

      // Fields the student typed by hand into a real application during onboarding. The content
      // script has no token and no host_permissions, so every write goes through here.
      //
      // Answers { stop: true } when the backend says harvest is over (403 = onboarding complete),
      // which latches the content script off for the page's lifetime. Without that the extension
      // would keep POSTing into a 403 on every keystroke of every application, forever.
      case 'HARVEST_FIELDS': {
        harvestFields(message.fields).then(sendResponse);
        return true; // async: see the convention note above - only async branches return true.
      }

      default:
        return false;
    }
  });
});
