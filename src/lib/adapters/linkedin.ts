import type { ApplicationProfile, AutofillResult, Profile } from '../types';

// LinkedIn Easy Apply adapter (PRD-v2-resume-autofill.md Section 7). Originally scoped as
// detection-only per v0 PRD Section 8's ban-risk discipline ("read only what the user is
// actively viewing, no automation of anything LinkedIn would flag"); per product direction
// 2026-07-02, form-fill now runs here too. The one-rule-zero-tolerance constraint still
// applies unchanged: this NEVER clicks Next/Review/Submit - it fills the currently-visible
// step and stops, same as every other adapter's fill-and-stop pattern.
//
// LinkedIn assigns every form field a per-posting-generated id (`urn:li:jobPosting:...`
// suffixes), so - unlike Lever/Greenhouse's stable name attributes - fields here are matched
// by label text exclusively, same defensive pattern as Greenhouse/Ashby's custom questions.
//
// Easy Apply is a multi-step modal (contact info -> resume -> screening questions ->
// review), and this fill only touches whatever step is visible when the student clicks
// "Yes, fill it" - it does not advance steps itself (that would require clicking Next,
// which is out of scope the same way clicking Submit is). If the student advances to a
// later step, content.ts's existing modal-mutation watcher can offer the card again for
// that step; each offer independently calls resume generation, so a multi-step application
// currently re-generates the resume per step rather than caching it across steps - a known
// limitation, not a bug, worth revisiting if this adapter sees real use.
//
// NOT live-tested against a real Easy Apply flow - LinkedIn's anti-automation posture and
// the same real-transaction risk that blocked live click-through testing on Lever/Greenhouse
// (documented in the 2026-07-02 session handoffs) apply here too. Selectors below are
// written from Easy Apply's well-documented, broadly-consistent DOM conventions. Verify
// against a real live posting before trusting it in front of a student.

const EASY_APPLY_MODAL_SELECTORS = [
  '[data-test-modal-id="easy-apply-modal"]',
  '[aria-label="Easy Apply"]',
  '.jobs-easy-apply-modal',
  '[class*="easy-apply-modal"]',
];

import { commitChoice, NEVER_FILL_LABEL_PATTERNS, randomDelay, setNativeValue, fillField, radioOptionsIn } from './shared/dom';

function getModal(): Element | null {
  for (const sel of EASY_APPLY_MODAL_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

export function isLinkedInApplicationPage(): boolean {
  if (!window.location.hostname.includes('linkedin.com')) return false;
  return getModal() !== null;
}

export function extractLinkedInJdText(): string {
  // The Easy Apply modal sits on top of the job posting, not inside it - the description
  // is still in the underlying page, not the modal.
  const descText = (
    document.querySelector('.jobs-description__content')?.textContent ??
    document.querySelector('#job-details')?.textContent ??
    document.querySelector('[class*="jobs-description"]')?.textContent ??
    ''
  ).trim();
  return (descText || document.body.innerText).trim().slice(0, 12000);
}

// Each question in the Easy Apply modal is wrapped in one of these grouping containers,
// with the question text in a nearby label/legend rather than always a real `<label for>`.
function questionBlocksIn(modal: Element): Element[] {
  return Array.from(
    modal.querySelectorAll('.fb-dash-form-element, .jobs-easy-apply-form-section__grouping, fieldset'),
  ).filter((el) => el.querySelector('input, select, textarea'));
}

function labelTextFor(el: Element): string {
  const legend = el.querySelector('legend');
  if (legend) return legend.textContent?.trim().toLowerCase() ?? '';
  const label = el.querySelector('label');
  return (label?.textContent ?? el.textContent ?? '').trim().toLowerCase();
}

function isNeverFillField(el: Element): boolean {
  return NEVER_FILL_LABEL_PATTERNS.some((re) => re.test(labelTextFor(el)));
}

async function checkRadio(radio: HTMLInputElement): Promise<void> {
  await randomDelay();
  commitChoice(radio);
}

// `<input type="file">` can't be set directly by script; construct a File/DataTransfer and
// dispatch it. LinkedIn's resume-upload card wraps a real file input in most postings.
async function fillResumeFile(modal: Element, blob: Blob, fileName: string): Promise<boolean> {
  const input = modal.querySelector<HTMLInputElement>(
    '.jobs-document-upload-redesign-card__container input[type="file"], input[type="file"][name="file"], input[type="file"]',
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

export interface LinkedInFillParams {
  fullName: string;
  email?: string;
  profile: Profile;
  applicationProfile: ApplicationProfile;
  resumeBlob?: Blob;
  resumeFileName?: string;
}

export async function fillLinkedInApplication(params: LinkedInFillParams): Promise<AutofillResult> {
  const { email, applicationProfile, resumeBlob, resumeFileName } = params;
  let fields_filled = 0;
  let fields_skipped = 0;
  const skipped_reasons: string[] = [];

  const modal = getModal();
  if (!modal) {
    return { ats_name: 'linkedin', fields_filled: 0, fields_skipped: 0, skipped_reasons: ['Easy Apply modal not found - it may have closed'] };
  }

  if (resumeBlob && resumeFileName) {
    if (await fillResumeFile(modal, resumeBlob, resumeFileName)) {
      fields_filled++;
    }
    // No file input on this step isn't a failure - Easy Apply's resume step is often a
    // separate step from contact info/screening questions, so a given fill pass may
    // legitimately have nothing to upload into on this particular step.
  }

  // Contact info + screening questions - matched by label text since LinkedIn generates a
  // fresh element id per posting. Phone/email are usually already pre-filled from the
  // LinkedIn profile Easy Apply reads from; only fill if genuinely empty.
  const blocks = questionBlocksIn(modal);
  for (const block of blocks) {
    if (isNeverFillField(block)) {
      fields_skipped++;
      skipped_reasons.push('never-fill field (SSN/license/background-check consent), left for manual entry');
      continue;
    }

    const label = labelTextFor(block);

    if (/phone/i.test(label) && applicationProfile.phone) {
      const input = block.querySelector<HTMLInputElement>('input[type="text"], input[type="tel"]');
      if (input && !input.value) {
        await fillField(input, applicationProfile.phone);
        fields_filled++;
        continue;
      }
    }
    if (/email/i.test(label) && email) {
      const input = block.querySelector<HTMLInputElement>('input[type="text"], input[type="email"]');
      if (input && !input.value) {
        await fillField(input, email);
        fields_filled++;
        continue;
      }
    }

    const linkTarget =
      /linkedin/i.test(label) ? undefined : // never overwrite the student's own LinkedIn profile URL field with itself
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
      // Never guess or default EEO/voluntary self-identification fields (PRD-v2 non-goals).
      const select = block.querySelector<HTMLSelectElement>('select');
      const declineOption = select ? [...select.options].find((o) => /decline/i.test(o.text)) : undefined;
      if (select && declineOption) {
        select.value = declineOption.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        fields_filled++;
        continue;
      }
      const declineRadio = radioOptionsIn(block).find((o) => /decline|prefer not/i.test(o.text));
      if (declineRadio) {
        await checkRadio(declineRadio.radio);
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
      // Same principle as Ashby: only fill when exactly one radio option unambiguously
      // means yes/no - never guess a specific visa type or similar multi-option answer.
      const options = radioOptionsIn(block);
      const yesLike = options.filter((o) => /^yes\b/.test(o.text));
      const noLike = options.filter((o) => /^(no|none|not required|no sponsorship)\b/.test(o.text));
      const match = wantYes ? (yesLike.length === 1 ? yesLike[0] : undefined) : (noLike.length === 1 ? noLike[0] : undefined);
      if (match) {
        await checkRadio(match.radio);
        fields_filled++;
        continue;
      }
      if (options.length > 0) {
        fields_skipped++;
        skipped_reasons.push(`${label.slice(0, 40)}: no unambiguous Yes/No option among [${options.map((o) => o.text).join(', ')}], left blank`);
        continue;
      }
    }

    // Open-ended screening questions are left blank rather than guessed (PRD-v2 Section 12.4).
    const textInput = block.querySelector('input[type="text"], textarea');
    if (textInput && !(textInput as HTMLInputElement).value) {
      fields_skipped++;
      skipped_reasons.push(`open-ended question left blank: "${label.slice(0, 60)}"`);
    }
  }

  return { ats_name: 'linkedin', fields_filled, fields_skipped, skipped_reasons };
}
