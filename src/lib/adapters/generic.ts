import type { ApplicationProfile, AutofillResult, Profile } from '../types';

// Generic adapter for companies that build their OWN application form on their own domain
// against an ATS's API (live-tested targets 2026-07-04: vercel.com/careers - Greenhouse API
// behind a native form; lifeatspotify.com - Lever API behind a native form). There are no
// stable per-ATS selectors here, so every field is matched by the text a human would read:
// its <label>, aria-label, placeholder, name, and id, in that order of trust.
//
// This adapter is never auto-injected. The content script only reaches an arbitrary company
// domain when the student clicks "Fill the form on this page" in the popup (activeTab +
// chrome.scripting), so running here is itself evidence of an explicit user request - the
// same consent posture as the ATS adapters, one notch more explicit.
//
// Scope, deliberately narrow for v1: text/email/tel/url inputs and the resume file input.
// Radios, checkboxes, selects, and open-ended questions are counted as skipped with reasons,
// never guessed - a wrong answer on a custom form is worse than a blank one.

const NEVER_FILL_PATTERNS = [
  /social security/i, /\bssn\b/i, /driver'?s?\s*licen[sc]e/i, /background check consent/i,
  /date of birth|birth\s*date|\bdob\b/i, /salary|compensation|desired pay/i,
  /gender|race|ethnicity|veteran|disability|pronouns/i,
];

function randomDelay(minMs = 120, maxMs = 380): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

// Everything a human could read as this field's identity, lowercased and concatenated.
// Label text is the strongest signal, so it goes first; name/id are the weakest (often
// framework-generated), so they go last.
function fieldIdentity(el: HTMLInputElement | HTMLTextAreaElement): string {
  const parts: string[] = [];
  const label =
    (el.labels && el.labels[0]?.textContent) ||
    (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : '') ||
    '';
  parts.push(label ?? '');
  parts.push(el.getAttribute('aria-label') ?? '');
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    parts.push(
      labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '),
    );
  }
  parts.push(el.getAttribute('placeholder') ?? '');
  parts.push(el.getAttribute('name') ?? '');
  parts.push(el.id ?? '');
  return parts.join(' ').toLowerCase();
}

function isAutocompleteWidget(el: HTMLElement): boolean {
  return el.getAttribute('role') === 'combobox' || !!el.getAttribute('aria-autocomplete');
}

function candidateInputs(): Array<HTMLInputElement | HTMLTextAreaElement> {
  return [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea',
  )].filter((el) => !el.closest('[id*="volley"]') && !el.disabled && !el.readOnly && isVisible(el));
}

// A page counts as an application form when it has either a resume-ish file input, or both a
// name-ish and an email-ish input. Search bars and newsletter signups have one of these at
// most, never the combination.
export function isLikelyApplicationForm(): boolean {
  const inputs = candidateInputs();
  const hasName = inputs.some((el) => /\bname\b/.test(fieldIdentity(el)));
  const hasEmail = inputs.some(
    (el) => (el as HTMLInputElement).type === 'email' || /e-?mail/.test(fieldIdentity(el)),
  );
  const fileInputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
  const hasResumeUpload = fileInputs.some((el) => {
    const ctx = `${fieldIdentity(el)} ${el.closest('div,section,fieldset')?.textContent?.slice(0, 200) ?? ''}`.toLowerCase();
    return /resume|\bcv\b|curriculum/.test(ctx);
  });
  return hasResumeUpload || (hasName && hasEmail);
}

export function extractGenericJdText(): string {
  return document.body.innerText.trim().slice(0, 12000);
}

// Meta tags first (companies that build their own careers pages usually set them), then the
// document title with any " | Site Name" / " - Site Name" tail stripped, then the hostname.
export function getGenericJobDetails(): { title: string; company: string } {
  const meta = (name: string) =>
    document.querySelector<HTMLMetaElement>(`meta[property="${name}"], meta[name="${name}"]`)?.content?.trim();

  let title = meta('og:title') || document.title || '';
  // "Senior Product Manager - Design Systems | Life at Spotify" -> drop the site-name tail,
  // but only the LAST segment and only for the weaker "|" separator or a tail that matches
  // the site name - job titles legitimately contain " - ".
  const site = meta('og:site_name');
  if (site && title.endsWith(site)) title = title.slice(0, title.length - site.length).replace(/[\s|–-]+$/, '');
  else if (title.includes(' | ')) title = title.split(' | ')[0].trim();

  const host = location.hostname.replace(/^www\./, '');
  const company = site || host.split('.')[0];
  return { title: title || 'this role', company: company || host };
}

async function fillTextField(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await randomDelay();
  el.focus();
  setNativeValue(el, value);
  el.blur();
}

function findResumeFileInput(): HTMLInputElement | null {
  const fileInputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].filter(
    (el) => !el.closest('[id*="volley"]'),
  );
  if (fileInputs.length === 0) return null;
  const scored = fileInputs.map((el) => {
    const ctx = `${fieldIdentity(el)} ${el.closest('div,section,fieldset')?.textContent?.slice(0, 200) ?? ''}`.toLowerCase();
    if (/cover\s*letter/.test(ctx)) return { el, score: -1 };
    if (/resume|\bcv\b|curriculum/.test(ctx)) return { el, score: 2 };
    return { el, score: 0 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score >= 0 ? scored[0].el : null;
}

export interface GenericFillParams {
  fullName: string;
  email?: string;
  profile: Profile;
  applicationProfile: ApplicationProfile;
  resumeBlob?: Blob;
  resumeFileName?: string;
}

export async function fillGenericApplication(params: GenericFillParams): Promise<AutofillResult> {
  const { fullName, email, applicationProfile, resumeBlob, resumeFileName } = params;
  let fields_filled = 0;
  let fields_skipped = 0;
  const skipped_reasons: string[] = [];

  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts[0] ?? '';
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

  for (const el of candidateInputs()) {
    if (el.value) continue; // never overwrite something the student already typed

    const identity = fieldIdentity(el);
    const inputType = (el as HTMLInputElement).type;

    if (NEVER_FILL_PATTERNS.some((re) => re.test(identity))) {
      fields_skipped++;
      skipped_reasons.push(`sensitive field left for manual entry: "${identity.slice(0, 50).trim()}"`);
      continue;
    }

    // Input type is a stronger signal than any label text.
    let value =
      inputType === 'email' ? email :
      inputType === 'tel' ? applicationProfile.phone :
      /first\s*name|given\s*name|preferred\s*name/.test(identity) ? firstName :
      /last\s*name|family\s*name|surname/.test(identity) ? lastName :
      /full\s*name|legal\s*name|your\s*name|^\s*name\b/.test(identity) ? fullName :
      /e-?mail/.test(identity) ? email :
      /phone|mobile/.test(identity) ? applicationProfile.phone :
      /linkedin/.test(identity) ? applicationProfile.linkedin_url :
      /github/.test(identity) ? applicationProfile.github_url :
      /portfolio|personal\s*(web)?site|\bwebsite\b/.test(identity) ? applicationProfile.portfolio_url :
      /\bcity\b|\blocation\b/.test(identity) ? applicationProfile.address_city :
      undefined;

    // Handle-style inputs (live-tested on vercel.com: a "linkedin.com/in/" prefix rendered
    // before the field, expecting just the handle) would double the URL if given the full
    // link - keep only the last path segment for those.
    if (value && /handle/.test(identity) && /^https?:\/\//.test(value)) {
      value = value.replace(/\/+$/, '').split('/').pop() ?? value;
    }

    if (value === undefined) {
      // A textarea with no mapping is an open-ended question; a text input we can't identify
      // is safer blank than wrong. Both are the same outcome, just reported honestly.
      if (el instanceof HTMLTextAreaElement || identity.trim()) {
        fields_skipped++;
        skipped_reasons.push(`unrecognized field left blank: "${identity.slice(0, 50).trim()}"`);
      }
      continue;
    }
    if (!value) {
      fields_skipped++;
      skipped_reasons.push(`no value in application profile for: "${identity.slice(0, 50).trim()}"`);
      continue;
    }
    if (isAutocompleteWidget(el) && !/linkedin|github|portfolio|e-?mail/.test(identity)) {
      // Typing into a suggestion-picker without selecting a suggestion usually doesn't
      // register as an answer (same reasoning as the Ashby location skip).
      fields_skipped++;
      skipped_reasons.push(`autocomplete field left for manual selection: "${identity.slice(0, 50).trim()}"`);
      continue;
    }

    await fillTextField(el, value);
    fields_filled++;
  }

  if (resumeBlob && resumeFileName) {
    const input = findResumeFileInput();
    if (input) {
      await randomDelay();
      const file = new File([resumeBlob], resumeFileName, { type: 'application/pdf' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      fields_filled++;
    } else {
      fields_skipped++;
      skipped_reasons.push('resume: no file input found on this form');
    }
  } else {
    fields_skipped++;
    skipped_reasons.push('resume: no generated resume file available');
  }

  const unhandled = document.querySelectorAll('select, input[type="radio"], input[type="checkbox"]').length;
  if (unhandled > 0) {
    fields_skipped++;
    skipped_reasons.push(`${unhandled} dropdown/radio/checkbox question(s) left for manual answers`);
  }

  return { ats_name: 'generic', fields_filled, fields_skipped, skipped_reasons };
}
