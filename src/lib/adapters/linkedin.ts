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

import {
  commitChoice,
  NEVER_FILL_LABEL_PATTERNS,
  randomDelay,
  setNativeValue,
  fillField,
  radioOptionsIn,
  isComboboxControl,
  openCombobox,
  pickComboOption,
  closeOpenCombobox,
} from './shared/dom';
// Reuse the generic adapter's pure answer-resolution engine so every adapter maps a question to
// the same answer and picks the same option. Pure (no DOM), covered by the adapter answer tests.
import { desiredAnswer, matchOption, type Desired } from './generic';

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

// ─── Shared answer helpers (mirror generic.ts's engine) ───────────────────────

// Drive a react-select / listbox combobox to the desired answer: open it, read the rendered
// options, click the confident match. Returns false (never guesses) when the menu never opens or
// no option matches, dismissing any open portal first.
async function fillCombobox(trigger: HTMLElement, desired: Desired): Promise<boolean> {
  if (!desired) return false;
  const typeahead = desired.mode === 'value' ? desired.value : undefined;
  const options = await openCombobox(trigger, typeahead);
  if (options.length === 0) { closeOpenCombobox(); return false; }
  const match = matchOption(options, desired);
  if (!match) { closeOpenCombobox(); return false; }
  await pickComboOption(match);
  return true;
}

function comboControlIn(block: Element): HTMLElement | null {
  return block.querySelector<HTMLElement>(
    'input[role="combobox"], [role="combobox"], [aria-haspopup="listbox"], [class*="select__control"], [class*="Select-control"]',
  );
}

// Answer a question block that resolved to a known desired value, across a native <select>,
// native radios (LinkedIn radios carry value="on", so match by the associated <label>), or a
// react-select combobox.
async function answerChoiceBlock(block: Element, desired: Desired): Promise<boolean> {
  if (!desired) return false;

  const select = block.querySelector<HTMLSelectElement>('select');
  if (select) {
    const options = [...select.options]
      .filter((o) => o.value && !/^(select|choose|please|--)/i.test(o.text.trim()))
      .map((o) => ({ text: o.text, value: o.value }));
    const m = matchOption(options, desired);
    if (m) {
      select.value = m.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
  }

  const radios = radioOptionsIn(block).map((r) => ({ text: r.text, el: r.radio }));
  if (radios.length > 0) {
    const m = matchOption(radios, desired);
    if (m) { await checkRadio(m.el); return true; }
  }

  const combo = comboControlIn(block);
  if (combo && isComboboxControl(combo) && (await fillCombobox(combo, desired))) return true;

  return false;
}

// Visually flag an AI-drafted field so the student can't miss that it needs review.
function markForReview(el: HTMLElement): void {
  el.style.outline = '2px solid #f59e0b';
  el.style.outlineOffset = '1px';
  const badge = document.createElement('div');
  badge.textContent = 'AI draft: review before submitting';
  badge.style.cssText = 'font:600 11px -apple-system,BlinkMacSystemFont,sans-serif;color:#b45309;margin-top:4px;';
  el.insertAdjacentElement('afterend', badge);
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
  // Generic-adapter extras, now honored here too. eeo carries the student's demographic prefs for
  // EEO questions; draftAnswer AI-drafts an open-ended textarea; onProgress streams counts.
  eeo?: Record<string, string>;
  draftAnswer?: (question: string) => Promise<string | null>;
  onProgress?: (partial: { fields_filled: number; fields_skipped: number; ai_drafted: number; pendingEssays: number }) => void;
}

export async function fillLinkedInApplication(params: LinkedInFillParams): Promise<AutofillResult> {
  const { email, applicationProfile, resumeBlob, resumeFileName, draftAnswer, onProgress } = params;
  const eeo = params.eeo ?? {};
  let fields_filled = 0;
  let fields_skipped = 0;
  let ai_drafted = 0;
  const skipped_reasons: string[] = [];
  const pendingDrafts: Array<{ el: HTMLTextAreaElement; question: string }> = [];

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
      // Real answer when the student stored one (eeo prefs), else decline. Works whether the
      // control is a native select, native radios (value="on", matched by label), or a combobox.
      const desired = desiredAnswer(label, applicationProfile, eeo);
      if (await answerChoiceBlock(block, desired)) {
        fields_filled++;
      } else {
        fields_skipped++;
        skipped_reasons.push('EEO field: no matching option found, left blank');
      }
      continue;
    }

    const isAuthQuestion = /authoriz(ed|ation) to work/i.test(label);
    const isSponsorQuestion = /sponsorship/i.test(label);
    const eligibilityAnswer = isAuthQuestion ? applicationProfile.work_authorized : applicationProfile.needs_sponsorship;
    // `!= null` and keyed to the RELEVANT field: an unset boolean arrives as `null` (not undefined),
    // and an auth question must not read a null work_authorized just because sponsorship is set.
    // Either slip previously answered "No" and could auto-reject an authorized student.
    if ((isAuthQuestion || isSponsorQuestion) && eligibilityAnswer != null) {
      const wantYes = eligibilityAnswer;
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
      // Some Easy Apply questions render as a react-select combobox rather than native radios.
      const combo = comboControlIn(block);
      if (combo && (await fillCombobox(combo, wantYes ? { mode: 'yes' } : { mode: 'no' }))) {
        fields_filled++;
        continue;
      }
      if (options.length > 0) {
        fields_skipped++;
        skipped_reasons.push(`${label.slice(0, 40)}: no unambiguous Yes/No option among [${options.map((o) => o.text).join(', ')}], left blank`);
        continue;
      }
    }

    // Other known-answer questions (age of majority, citizenship, availability, referral source,
    // salary, DOB) resolved from the profile, across select / radio / combobox / free text.
    const known = desiredAnswer(label, applicationProfile, eeo);
    if (known) {
      if (await answerChoiceBlock(block, known)) {
        fields_filled++;
        continue;
      }
      if (known.mode === 'value') {
        const textEl = block.querySelector<HTMLInputElement>('input[type="text"], input[type="url"], input[type="tel"]');
        if (textEl && !textEl.value && !isComboboxControl(textEl)) {
          await fillField(textEl, known.value);
          fields_filled++;
          continue;
        }
      }
      fields_skipped++;
      skipped_reasons.push(`${label.slice(0, 40)}: no matching control, left blank`);
      continue;
    }

    // Open-ended screening questions: draft the textarea via the hook if available (flagged for
    // review), else leave it blank. Short text inputs we couldn't map stay blank for the student.
    const textarea = block.querySelector<HTMLTextAreaElement>('textarea');
    if (textarea && !textarea.value) {
      if (draftAnswer) {
        pendingDrafts.push({ el: textarea, question: label.slice(0, 200) });
      } else {
        fields_skipped++;
        skipped_reasons.push(`open-ended question left blank: "${label.slice(0, 60)}"`);
      }
      continue;
    }
    const textInput = block.querySelector<HTMLInputElement>('input[type="text"]');
    if (textInput && !textInput.value) {
      fields_skipped++;
      skipped_reasons.push(`open-ended question left blank: "${label.slice(0, 60)}"`);
    }
  }

  // Draft every collected essay CONCURRENTLY (each is an independent LLM round trip), writing and
  // flagging each as it resolves. A failed or empty draft falls back to leaving it blank, unchanged.
  if (pendingDrafts.length > 0 && draftAnswer) {
    let pendingEssays = pendingDrafts.length;
    onProgress?.({ fields_filled, fields_skipped, ai_drafted, pendingEssays });
    await Promise.all(
      pendingDrafts.map(async ({ el, question }) => {
        let drafted: string | null = null;
        try {
          drafted = (await draftAnswer(question))?.trim() || null;
        } catch {
          drafted = null;
        }
        if (drafted) {
          await fillField(el, drafted);
          markForReview(el);
          ai_drafted++;
          fields_filled++;
        } else {
          fields_skipped++;
          skipped_reasons.push(`open-ended question left blank: "${question.slice(0, 60)}"`);
        }
        pendingEssays--;
        onProgress?.({ fields_filled, fields_skipped, ai_drafted, pendingEssays });
      }),
    );
  }

  if (ai_drafted > 0) {
    skipped_reasons.unshift(`${ai_drafted} open-ended answer${ai_drafted === 1 ? '' : 's'} AI-drafted, review before submitting`);
  }

  return { ats_name: 'linkedin', fields_filled, fields_skipped, skipped_reasons };
}
