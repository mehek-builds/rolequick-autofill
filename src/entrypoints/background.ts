const API_BASE = 'http://localhost:3001';

async function getStoredToken(): Promise<string | null> {
  const result = await chrome.storage.local.get('token');
  return result.token ?? null;
}

async function resolveAndDraft(title: string, company: string, url: string, token: string) {
  // Resolve contacts
  const resolveRes = await fetch(`${API_BASE}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ company, role: title, domain: company.toLowerCase().replace(/\s+/g, '') + '.com' }),
  });
  if (!resolveRes.ok) throw new Error('resolve failed');
  const contacts: Array<{ id: string; full_name: string; title: string; persona: string; tier: string; email?: string; school_match: boolean; company_domain: string }> = await resolveRes.json();

  // Draft for top 2 verified/likely contacts
  const top = contacts.filter(c => c.tier === 'green' || c.tier === 'amber').slice(0, 2);
  if (top.length === 0) return [];

  const profileRes = await fetch(`${API_BASE}/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const userProfile = profileRes.ok ? await profileRes.json() : null;

  const drafts = await Promise.all(top.map(async (contact) => {
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
        },
        role: title,
        company,
        user_profile: userProfile?.parsed_json ?? {},
      }),
    });
    if (!draftRes.ok) return null;
    const draft = await draftRes.json();
    return { contact, draft, job: { company, role: title, url } };
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
