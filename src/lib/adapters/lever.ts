import type { ApplicationProfile, AutofillResult, Profile } from '../types';

// Lever field-mapping adapter (PRD-v2-resume-autofill.md Section 7). Lever is the recommended
// first ATS to ship (simple same-page form, static DOM, no cross-origin iframe like Greenhouse
// sometimes has). This fills what it can from the stored application profile + resume, skips
// anything it's told never to touch, and NEVER clicks Submit - Section 5 Step 4's one rule with
// zero tolerance for drift.

import { commitChoice } from './shared/dom';

const NEVER_FILL_LABEL_PATTERNS = [/social security/i, /ssn\b/i, /driver'?s?\s*licen[sc]e/i, /background check consent/i];

// Staggered delays between field fills (PRD-v2 Section 12.6: built in from the first adapter,
// not retrofitted later) so the fill pattern reads less like a bot filling every field in
// under a second. Exact values are a tuning question once real fill behavior is observable.
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

function labelTextFor(el: Element): string {
  const container = el.closest('.application-question, .card, li') ?? el.parentElement;
  return (container?.textContent ?? '').trim().toLowerCase();
}

function isNeverFillField(el: Element): boolean {
  const label = labelTextFor(el);
  return NEVER_FILL_LABEL_PATTERNS.some((re) => re.test(label));
}

async function fillField(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await randomDelay();
  el.focus();
  setNativeValue(el, value);
  el.blur();
}

// `<input type="file">` can't be set directly by script; construct a File/DataTransfer and
// dispatch it (PRD-v2 Section 9). Works for same-origin, non-sandboxed inputs, which Lever's
// resume field is.
async function fillResumeFile(input: HTMLInputElement, blob: Blob, fileName: string): Promise<void> {
  await randomDelay();
  const file = new File([blob], fileName, { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export interface LeverFillParams {
  fullName: string;
  email?: string;
  profile: Profile;
  applicationProfile: ApplicationProfile;
  resumeBlob?: Blob;
  resumeFileName?: string;
}

export function isLeverApplicationPage(): boolean {
  return window.location.hostname.includes('lever.co') && window.location.pathname.includes('/apply');
}

export function extractLeverJdText(): string {
  const desc = document.querySelector('.posting-page, [data-qa="posting-description"], .section-wrapper');
  const descText = desc?.textContent?.trim();
  return (descText || document.body.innerText).trim().slice(0, 12000);
}

export async function fillLeverApplication(params: LeverFillParams): Promise<AutofillResult> {
  const { fullName, email, profile, applicationProfile, resumeBlob, resumeFileName } = params;
  let fields_filled = 0;
  let fields_skipped = 0;
  const skipped_reasons: string[] = [];

  const nameEl = document.querySelector<HTMLInputElement>('input[name="name"]');
  const emailEl = document.querySelector<HTMLInputElement>('input[name="email"]');
  const phoneEl = document.querySelector<HTMLInputElement>('input[name="phone"]');
  const orgEl = document.querySelector<HTMLInputElement>('input[name="org"]');
  const resumeEl = document.querySelector<HTMLInputElement>('input[name="resume"][type="file"]');

  if (nameEl && !nameEl.value && fullName) {
    await fillField(nameEl, fullName);
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
  if (phoneEl && applicationProfile.phone) {
    await fillField(phoneEl, applicationProfile.phone);
    fields_filled++;
  }
  if (orgEl && profile.experience[0]?.company) {
    await fillField(orgEl, profile.experience[0].company);
    fields_filled++;
  }

  const urlFields: Array<{ selector: string; value?: string }> = [
    { selector: 'input[name="urls[LinkedIn]"]', value: applicationProfile.linkedin_url },
    { selector: 'input[name="urls[GitHub]"]', value: applicationProfile.github_url },
    { selector: 'input[name="urls[Portfolio]"]', value: applicationProfile.portfolio_url },
  ];
  for (const { selector, value } of urlFields) {
    const el = document.querySelector<HTMLInputElement>(selector);
    if (!el) continue;
    if (value) {
      await fillField(el, value);
      fields_filled++;
    } else {
      fields_skipped++;
      skipped_reasons.push(`${selector}: no value in application profile`);
    }
  }

  if (resumeEl && resumeBlob && resumeFileName) {
    await fillResumeFile(resumeEl, resumeBlob, resumeFileName);
    fields_filled++;
  } else if (resumeEl) {
    fields_skipped++;
    skipped_reasons.push('resume: no generated resume file available');
  }

  // Work authorization / sponsorship - the two questions that appear on nearly every US ATS
  // form (PRD-v2 Section 4B). Lever renders these as custom "additional questions" with no
  // stable name attribute, so match on label text rather than a selector.
  const questionBlocks = document.querySelectorAll('.application-question, .card');
  for (const block of questionBlocks) {
    if (isNeverFillField(block)) {
      fields_skipped++;
      skipped_reasons.push('never-fill field (SSN/license/background-check consent), left for manual entry');
      continue;
    }

    const label = labelTextFor(block);
    const isEeo = /gender|race|ethnicity|veteran|disability/i.test(label);
    if (isEeo) {
      // EEO fields: never guess or default to a filled value (PRD-v2 non-goals). Only select
      // "Decline to Self-Identify" where the option exists; otherwise leave untouched.
      const declineOption = block.querySelector<HTMLInputElement | HTMLOptionElement>(
        'input[value*="Decline" i], option[value*="Decline" i]',
      );
      if (declineOption instanceof HTMLInputElement) {
        commitChoice(declineOption);
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
      const target = block.querySelector<HTMLInputElement>(
        `input[type="radio"][value="${wantYes ? 'Yes' : 'No'}" i]`,
      );
      if (target) {
        commitChoice(target);
        fields_filled++;
        continue;
      }
    }

    // Open-ended screening questions are left blank rather than guessed (PRD-v2 Section 12.4):
    // a wrong guess here is worse than an empty field the student fills themselves.
    const textInput = block.querySelector('input[type="text"], textarea');
    if (textInput) {
      fields_skipped++;
      skipped_reasons.push(`open-ended question left blank: "${label.slice(0, 60)}"`);
    }
  }

  return { ats_name: 'lever', fields_filled, fields_skipped, skipped_reasons };
}
