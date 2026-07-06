import type { ApplicationProfile, AutofillResult, Profile } from '../types';

// Workday adapter (PRD-v2-resume-autofill.md Section 7). Originally scoped as
// detection-only per Section 3's "no full Workday multi-page wizard automation in v2.0"
// non-goal; per product direction 2026-07-02, form-fill now runs here too, gated on the
// same "account already exists" check Section 12's resolved item 5 introduced for
// detection - the badge (and now the fill) never fires during Workday's account-creation
// step, only once the student has an account and has actually landed on the real
// application-form page.
//
// Workday tenants vary widely in DOM structure (this is a hosted platform white-labeled
// per company, not a single shared template like Greenhouse/Lever/Ashby), so both the
// detection heuristic and the fill selectors below are written from Workday's
// well-documented, broadly-consistent `data-automation-id` conventions, NOT from a live
// test against a real tenant the way Lever/Greenhouse/Ashby were. Treat this as a
// starting point - verify against a real live posting before trusting it in front of a
// student, the same caveat the detection-only version of this file already carried.
//
// Account-creation heuristic: Workday's create-account/sign-in step always renders a
// password input and account-related copy; the real application form (after account
// creation) renders resume-upload and "My Experience"/"My Information" step markers instead.
// A page showing both (rare, but possible mid-transition) is treated as NOT yet a real
// application page - false negatives here are the safe failure mode (erring toward not
// firing beats firing too early, same as detection).

import { commitChoice } from './shared/dom';

const NEVER_FILL_LABEL_PATTERNS = [/social security/i, /ssn\b/i, /driver'?s?\s*licen[sc]e/i, /background check consent/i];

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

async function fillField(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await randomDelay();
  el.focus();
  setNativeValue(el, value);
  el.blur();
}

function hasAccountCreationMarkers(): boolean {
  const hasPasswordField = !!document.querySelector('input[type="password"]');
  if (hasPasswordField) return true;
  // Live-tested 2026-07-03 (a real NVIDIA posting): the body-text fallback below false-
  // positived on every single step of the 7-step flow, not just account creation, because
  // Workday's persistent step-progress list literally reads "current step 1 of 7: Create
  // Account/Sign In" and stays in the DOM throughout - the text regex matched that label,
  // not actual page content. Requiring at least one real input field on the page (the sign-
  // in landing screen has zero before the student picks a method) filters that out.
  if (document.querySelectorAll('input').length === 0) return false;
  const bodyText = document.body.innerText.toLowerCase();
  return /create account|create an account|sign in to your account|verify your email/.test(bodyText);
}

function hasApplicationFormMarkers(): boolean {
  const hasResumeUpload = !!document.querySelector(
    '[data-automation-id="file-upload-drop-zone"], [data-automation-id*="resumeUpload"], input[type="file"]',
  );
  const hasStepMarkers = !!document.querySelector(
    '[data-automation-id="myExperience"], [data-automation-id="myInformation"], [data-automation-id="pageHeader"]',
  );
  return hasResumeUpload || hasStepMarkers;
}

function looksLikeApplyUrl(): boolean {
  const path = window.location.pathname.toLowerCase();
  return path.includes('/apply') || (path.includes('/job/') && path.endsWith('/apply'));
}

export function isWorkdayApplicationPage(): boolean {
  const h = window.location.hostname;
  if (!h.includes('myworkdayjobs.com') && !h.includes('workday.com')) return false;
  if (!looksLikeApplyUrl()) return false;
  if (hasAccountCreationMarkers()) return false; // never fire during account creation
  return hasApplicationFormMarkers();
}

// 2026-07-03: Volley never creates the Workday account itself (backend-driven third-party
// account creation was scoped, researched, and explicitly decided against - see project memory
// for the CFAA/agency-law reasoning). This only pre-fills the signup form's own fields so the
// student reviews and clicks "Create Account" themselves, same fill-and-stop trust model as
// every other adapter - it's the speed-up that's actually in scope, not a way around the
// account-creation boundary.
export function isWorkdayAccountCreationPage(): boolean {
  const h = window.location.hostname;
  if (!h.includes('myworkdayjobs.com') && !h.includes('workday.com')) return false;
  if (!looksLikeApplyUrl()) return false;
  return hasAccountCreationMarkers();
}

// The "Start Your Application" triage screen most Workday tenants show before any of the
// above - three options (Workday's own resume-autofill, "Apply Manually", "Use My Last
// Application"), none of which are a password field or the real form yet, so neither
// isWorkdayAccountCreationPage() nor isWorkdayApplicationPage() fires here and the student was
// previously left with no guidance at all. "Apply Manually" is the option this adapter's
// selectors are actually built against (the other two skip or alter the flow in ways not
// verified here), so that's the one to point the student at.
export function isWorkdayStartScreen(): boolean {
  const h = window.location.hostname;
  if (!h.includes('myworkdayjobs.com') && !h.includes('workday.com')) return false;
  // No looksLikeApplyUrl() gate here, unlike the other two stage checks: NVIDIA (live-tested
  // 2026-07-04) opens this triage screen as a modal OVER the /details/... URL, before any
  // /apply navigation exists. The DOM check is specific enough on its own - the literal
  // "Start Your Application" heading plus an exact-text "Apply Manually" button only ever
  // co-occur on this one Workday screen.
  if (hasAccountCreationMarkers() || hasApplicationFormMarkers()) return false;
  return /start your application/i.test(document.body.innerText) && !!findApplyManuallyButton();
}

export function findApplyManuallyButton(): Element | null {
  const buttons = Array.from(document.querySelectorAll('button, a, div[role="button"]'));
  return buttons.find((b) => /^apply manually$/i.test(b.textContent?.trim() || '')) ?? null;
}

export function extractWorkdayJdText(): string {
  // The job-posting page and the application-form page are often different URLs on
  // Workday; some tenants keep a summary of the role visible in a sidebar throughout
  // the apply flow (`jobPostingHeader`), but this isn't guaranteed across tenants, so
  // this falls back to whatever text is on the current page rather than failing closed.
  const descText = (
    document.querySelector('[data-automation-id="jobPostingHeader"]')?.closest('div')?.textContent ??
    document.querySelector('[data-automation-id="jobPostingDescription"]')?.textContent ??
    ''
  ).trim();
  return (descText || document.body.innerText).trim().slice(0, 12000);
}

// `<input type="file">` can't be set directly by script; construct a File/DataTransfer and
// dispatch it. Workday's upload widget renders a dropzone over a real file input in most
// tenants; this targets that input directly rather than the dropzone UI element.
async function fillResumeFile(blob: Blob, fileName: string): Promise<boolean> {
  const input = document.querySelector<HTMLInputElement>(
    '[data-automation-id="file-upload-drop-zone"] input[type="file"], [data-automation-id*="resumeUpload"] input[type="file"], input[type="file"]',
  );
  if (!input) return false;
  await randomDelay();
  const file = new File([blob], fileName, { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function labelTextFor(el: Element): string {
  // Workday wraps most fields in a container carrying `data-automation-id` ending in
  // "...Section" or similar, with the visible question text elsewhere in that container
  // (not always a real <label for=...>) - fall back to the whole container's text.
  const container = el.closest('[data-automation-id$="Section"], fieldset, li') ?? el.parentElement;
  return (container?.textContent ?? '').trim().toLowerCase();
}

function isNeverFillField(el: Element): boolean {
  return NEVER_FILL_LABEL_PATTERNS.some((re) => re.test(labelTextFor(el)));
}

export interface WorkdayFillParams {
  fullName: string;
  email?: string;
  profile: Profile;
  applicationProfile: ApplicationProfile;
  resumeBlob?: Blob;
  resumeFileName?: string;
}

function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

export async function fillWorkdayApplication(params: WorkdayFillParams): Promise<AutofillResult> {
  const { fullName, email, applicationProfile, resumeBlob, resumeFileName } = params;
  let fields_filled = 0;
  let fields_skipped = 0;
  const skipped_reasons: string[] = [];

  // High-confidence fields: these automation-id conventions are broadly consistent across
  // Workday tenants per public documentation, unlike everything else on this platform.
  const firstEl = document.querySelector<HTMLInputElement>('input[data-automation-id="legalNameSection_firstName"]');
  const lastEl = document.querySelector<HTMLInputElement>('input[data-automation-id="legalNameSection_lastName"]');
  const emailEl = document.querySelector<HTMLInputElement>('input[data-automation-id="email"]');
  const phoneEl = document.querySelector<HTMLInputElement>('input[data-automation-id="phone-number"]');
  const cityEl = document.querySelector<HTMLInputElement>('input[data-automation-id="addressSection_city"]');

  if (firstEl && !firstEl.value && fullName) {
    await fillField(firstEl, splitName(fullName).first);
    fields_filled++;
  }
  if (lastEl && !lastEl.value && fullName) {
    await fillField(lastEl, splitName(fullName).last);
    fields_filled++;
  }
  if (emailEl && !emailEl.value) {
    if (email) {
      await fillField(emailEl, email);
      fields_filled++;
    } else {
      fields_skipped++;
      skipped_reasons.push('email: not present in stored profile');
    }
  }
  if (phoneEl && !phoneEl.value && applicationProfile.phone) {
    await fillField(phoneEl, applicationProfile.phone);
    fields_filled++;
  }
  if (cityEl && !cityEl.value && applicationProfile.address_city) {
    await fillField(cityEl, applicationProfile.address_city);
    fields_filled++;
  }

  if (resumeBlob && resumeFileName) {
    if (await fillResumeFile(resumeBlob, resumeFileName)) {
      fields_filled++;
    } else {
      fields_skipped++;
      skipped_reasons.push('resume: no file input found in this frame');
    }
  } else {
    fields_skipped++;
    skipped_reasons.push('resume: no generated resume file available');
  }

  // Everything else (links, work-auth, sponsorship, EEO, screening questions) is
  // tenant-specific with no stable automation-id, so match by label text - same
  // defensive pattern as the other three adapters - and skip+flag rather than guess.
  const questionBlocks = Array.from(
    document.querySelectorAll('[data-automation-id$="Section"], fieldset'),
  ).filter((el) => el.querySelector('input, select, textarea'));

  for (const block of questionBlocks) {
    if (isNeverFillField(block)) {
      fields_skipped++;
      skipped_reasons.push('never-fill field (SSN/license/background-check consent), left for manual entry');
      continue;
    }

    const label = labelTextFor(block);

    const linkTarget =
      /linkedin/i.test(label) ? applicationProfile.linkedin_url :
      /github/i.test(label) ? applicationProfile.github_url :
      /portfolio|website/i.test(label) ? applicationProfile.portfolio_url :
      undefined;
    if (linkTarget !== undefined) {
      const input = block.querySelector<HTMLInputElement>('input[type="text"], input[type="url"]');
      if (input && !input.value) {
        if (linkTarget) {
          await fillField(input, linkTarget);
          fields_filled++;
        } else {
          fields_skipped++;
          skipped_reasons.push(`${label.slice(0, 40)}: no value in application profile`);
        }
        continue;
      }
    }

    const isEeo = /gender|race|ethnicity|veteran|disability/i.test(label);
    if (isEeo) {
      // Never guess or default EEO fields (PRD-v2 non-goals). Only select a decline-to-answer
      // option where one exists; otherwise leave the field untouched.
      const select = block.querySelector<HTMLSelectElement>('select');
      const declineOption = select ? [...select.options].find((o) => /decline/i.test(o.text)) : undefined;
      if (select && declineOption) {
        select.value = declineOption.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        fields_filled++;
        continue;
      }
      const declineRadio = block.querySelector<HTMLInputElement>('input[type="radio"][value*="Decline" i]');
      if (declineRadio) {
        commitChoice(declineRadio);
        fields_filled++;
      } else {
        fields_skipped++;
        skipped_reasons.push('EEO field: no decline-to-answer option found, left blank');
      }
      continue;
    }

    const isAuthQuestion = /authoriz(ed|ation) to work/i.test(label);
    const isSponsorQuestion = /sponsorship/i.test(label);
    if ((isAuthQuestion || isSponsorQuestion) && (applicationProfile.work_authorized !== undefined || applicationProfile.needs_sponsorship !== undefined)) {
      const wantYes = isAuthQuestion ? applicationProfile.work_authorized : applicationProfile.needs_sponsorship;
      const radio = block.querySelector<HTMLInputElement>(`input[type="radio"][value="${wantYes ? 'Yes' : 'No'}" i]`);
      if (radio) {
        commitChoice(radio);
        fields_filled++;
        continue;
      }
      const select = block.querySelector<HTMLSelectElement>('select');
      if (select) {
        const opt = [...select.options].find((o) => new RegExp(wantYes ? '^yes' : '^no', 'i').test(o.text.trim()));
        if (opt) {
          select.value = opt.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          fields_filled++;
          continue;
        }
      }
      fields_skipped++;
      skipped_reasons.push(`${label.slice(0, 40)}: no clean Yes/No control found, left blank`);
      continue;
    }

    const textInput = block.querySelector('input[type="text"], textarea');
    if (textInput && !(textInput as HTMLInputElement).value) {
      fields_skipped++;
      skipped_reasons.push(`open-ended question left blank: "${label.slice(0, 60)}"`);
    }
  }

  return { ats_name: 'workday', fields_filled, fields_skipped, skipped_reasons };
}

export interface WorkdayAccountCreationParams {
  email?: string;
}

// Fills only the email field and stops - password is deliberately never touched here (2026-07-03
// product decision: the student sets and enters their own password, clicks Create Account, and
// completes email verification entirely on their own). This is the one Volley-fillable field on
// the signup form, not a fill-and-stop pattern with a countdown to auto-submit - there's nothing
// to auto-submit toward since the password field is always left for the student to fill by hand.
export async function fillWorkdayAccountCreation(params: WorkdayAccountCreationParams): Promise<AutofillResult> {
  const { email } = params;
  let fields_filled = 0;
  let fields_skipped = 0;
  const skipped_reasons: string[] = [];

  const emailEl = document.querySelector<HTMLInputElement>('input[data-automation-id="email"], input[type="email"]');
  if (emailEl && !emailEl.value) {
    if (email) {
      await fillField(emailEl, email);
      fields_filled++;
    } else {
      fields_skipped++;
      skipped_reasons.push('email: not present in stored profile');
    }
  }

  return { ats_name: 'workday', fields_filled, fields_skipped, skipped_reasons };
}
