import type { ApplicationProfile, AutofillResult, Profile } from '../types';

// Greenhouse field-mapping adapter (PRD-v2-resume-autofill.md Section 7, build-order step 2).
//
// Verified 2026-07-01 against a live posting (job-boards.greenhouse.io/gemini/jobs/7875125):
// Greenhouse's CURRENT default template (job-boards.greenhouse.io) uses id-based fields with
// EMPTY name attributes (#first_name, #last_name, #email, #phone, #candidate-location, #resume,
// #cover_letter) and wraps every field - core and custom - in a `.field-wrapper` containing a
// real <label>. This is a different convention from the older `job_application[first_name]`
// name-based one (still used by some legacy boards.greenhouse.io embeds), so both are tried,
// id-based first. Custom questions get per-posting `#question_<id>` ids, so those are still
// matched by label text like the Lever adapter.
//
// The other thing live testing caught: yes/no questions (work-authorization, sponsorship), the
// EEO "decline to answer" options, and the city field are NOT plain inputs or native <select>
// elements. They are react-select comboboxes (role="combobox", aria-autocomplete="list",
// aria-controls="react-select-<id>-listbox" once open). Setting .value directly does nothing
// real: react-select clears it back to empty on blur since no option was actually selected.
// These are now driven through the shared combobox helpers (openCombobox / pickComboOption),
// which open the menu with a real pointer sequence and click the matching option node the way a
// user does. Where the menu never opens or no option matches, the field is left blank and
// flagged rather than faked (closeOpenCombobox dismisses any lingering portal).
//
// Cross-origin iframe (Section 12.3's spike): some companies embed their Greenhouse board inside
// an iframe on their own domain (e.g. company.com/careers embedding boards.greenhouse.io/company).
// A Chrome content script's `matches` patterns are evaluated per-frame, not per-tab, so as long as
// the manifest also sets `all_frames: true`, a content script matching `*.greenhouse.io/*` injects
// directly into that iframe (it runs with the iframe's own origin, not the parent page's) - no
// special cross-frame messaging needed. This only breaks for the rarer case of a fully custom
// embed that proxies the form through the parent's own origin instead of an iframe pointing at a
// greenhouse.io URL; that case still isn't covered and is flagged below.

import {
  commitChoice,
  NEVER_FILL_LABEL_PATTERNS,
  randomDelay,
  fillField,
  splitName,
  isComboboxControl,
  openCombobox,
  pickComboOption,
  closeOpenCombobox,
} from './shared/dom';
// Reuse the generic adapter's pure answer-resolution engine so every adapter maps a question to
// the same answer and picks the same option. These are pure (no DOM) and covered by
// generic.answers.test.ts + ats-answer.test.ts.
import { desiredAnswer, matchOption, workAuthWantYes, type Desired } from './generic';

function labelTextFor(el: Element): string {
  const container = el.closest('.field-wrapper, .field, #custom_fields > div, li') ?? el.parentElement;
  const label = container?.querySelector('label');
  return (label?.textContent ?? container?.textContent ?? '').trim().toLowerCase();
}

function firstMatch<T extends Element>(selectors: string[]): T | null {
  for (const sel of selectors) {
    const el = document.querySelector<T>(sel);
    if (el) return el;
  }
  return null;
}

function isNeverFillField(el: Element): boolean {
  const label = labelTextFor(el);
  return NEVER_FILL_LABEL_PATTERNS.some((re) => re.test(label));
}

// ─── Shared answer helpers (mirror generic.ts's engine) ───────────────────────

// Drive a react-select / listbox combobox to the desired answer: open it, read the rendered
// options, click the confident match. Poking .value does nothing to these widgets, which is why
// they were previously collected and skipped. Returns false (never guesses) when the menu never
// opens or no option matches, dismissing any open portal first.
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

// The combobox trigger inside a question block, if the block renders one.
function comboControlIn(block: Element): HTMLElement | null {
  return block.querySelector<HTMLElement>(
    'input[role="combobox"], [role="combobox"], [aria-haspopup="listbox"], [class*="select__control"], [class*="Select-control"]',
  );
}

// Answer a question block that resolved to a known desired value, across the three shapes an ATS
// renders a choice as: a native <select>, native radios, or a react-select combobox. Radio option
// text prefers the associated <label>, falling back to the value attribute.
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

  const radios = [...block.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((r) => ({
    text: (document.querySelector(`label[for="${r.id}"]`)?.textContent ?? r.closest('label')?.textContent ?? r.value ?? '').trim(),
    el: r,
  }));
  if (radios.length > 0) {
    const m = matchOption(radios, desired);
    if (m) { commitChoice(m.el); return true; }
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

// `<input type="file">` can't be set directly by script; construct a File/DataTransfer and
// dispatch it (PRD-v2 Section 9). Greenhouse's dropzone UI sits on top of a real file input in
// same-origin embeds, which this works against; it does not work if the dropzone itself is the
// only interactive element with no underlying <input type="file"> in this frame's DOM (rare, but
// flagged rather than silently failing - the caller reports it as a skipped field).
async function fillResumeFile(input: HTMLInputElement, blob: Blob, fileName: string): Promise<void> {
  await randomDelay();
  const file = new File([blob], fileName, { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export interface GreenhouseFillParams {
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

export function isGreenhouseApplicationPage(): boolean {
  const h = window.location.hostname;
  if (!h.includes('greenhouse.io')) return false;
  const path = window.location.pathname.toLowerCase();
  if (path.includes('/application') || path.includes('/apply')) return true;
  const hasNameField = !!document.querySelector('#first_name, input[name="job_application[first_name]"]');
  const hasResumeUpload = !!document.querySelector('input[type="file"], [data-source="resume"], #resume_dropzone');
  return hasNameField || hasResumeUpload;
}

export function extractGreenhouseJdText(): string {
  const desc = document.querySelector('#content, .job__description, [data-qa="job-description"]');
  const descText = desc?.textContent?.trim();
  return (descText || document.body.innerText).trim().slice(0, 12000);
}

export async function fillGreenhouseApplication(params: GreenhouseFillParams): Promise<AutofillResult> {
  const { fullName, email, applicationProfile, resumeBlob, resumeFileName, draftAnswer, onProgress } = params;
  const eeo = params.eeo ?? {};
  let fields_filled = 0;
  let fields_skipped = 0;
  let ai_drafted = 0;
  const skipped_reasons: string[] = [];
  const pendingDrafts: Array<{ el: HTMLTextAreaElement; question: string }> = [];

  const firstEl = firstMatch<HTMLInputElement>(['#first_name', 'input[name="job_application[first_name]"]']);
  const lastEl = firstMatch<HTMLInputElement>(['#last_name', 'input[name="job_application[last_name]"]']);
  const emailEl = firstMatch<HTMLInputElement>(['#email', 'input[name="job_application[email]"]']);
  const phoneEl = firstMatch<HTMLInputElement>(['#phone', 'input[name="job_application[phone]"]']);
  const cityEl = firstMatch<HTMLInputElement>(['#candidate-location']);
  const resumeEl = firstMatch<HTMLInputElement>([
    '#resume',
    'input[type="file"][name="job_application[resume]"]',
    '#resume_dropzone input[type="file"]',
  ]);

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
  if (phoneEl && applicationProfile.phone) {
    await fillField(phoneEl, applicationProfile.phone);
    fields_filled++;
  }
  if (cityEl && !cityEl.value && applicationProfile.address_city) {
    if (isComboboxControl(cityEl)) {
      if (await fillCombobox(cityEl, { mode: 'value', value: applicationProfile.address_city })) {
        fields_filled++;
      } else {
        fields_skipped++;
        skipped_reasons.push('city: no matching option found in the location picker, left blank');
      }
    } else {
      await fillField(cityEl, applicationProfile.address_city);
      fields_filled++;
    }
  }

  if (resumeEl && resumeBlob && resumeFileName) {
    await fillResumeFile(resumeEl, resumeBlob, resumeFileName);
    fields_filled++;
  } else if (resumeEl) {
    fields_skipped++;
    skipped_reasons.push('resume: no generated resume file available');
  } else {
    fields_skipped++;
    skipped_reasons.push('resume: no file input found in this frame (possible cross-origin embed without a same-frame uploader)');
  }

  // Custom fields (links, work-auth, sponsorship, EEO, screening) get dynamic per-posting IDs, so
  // match by the surrounding label text instead of a selector - same approach as the Lever adapter.
  const questionBlocks = document.querySelectorAll(
    '.field-wrapper, #custom_fields .field, #custom_fields > div, .eeoc-container .field',
  );
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
      // Real answer when the student stored one (eeo prefs), else decline. Works whether the
      // control is a native select, native radios, or a react-select combobox.
      const desired = desiredAnswer(label, applicationProfile, eeo);
      if (await answerChoiceBlock(block, desired)) {
        fields_filled++;
      } else {
        fields_skipped++;
        skipped_reasons.push('EEO field: no matching option found, left blank');
      }
      continue;
    }

    const wantYes = workAuthWantYes(label, applicationProfile);
    if (wantYes !== null) {
      const desired: Desired = wantYes ? { mode: 'yes' } : { mode: 'no' };

      // Native radios carry real values on Greenhouse (value="Yes"/"No"); try those first.
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
      // Verified live (2026-07-01, Gemini's Greenhouse posting): these yes/no questions render as
      // a react-select combobox far more often than a plain input. Drive it through the shared
      // combobox helpers, which open the menu and click the matching option.
      const combo = comboControlIn(block);
      if (combo && (await fillCombobox(combo, desired))) {
        fields_filled++;
        continue;
      }
      fields_skipped++;
      skipped_reasons.push(`${label.slice(0, 40)}: no matching Yes/No control found, left blank`);
      continue;
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
        pendingDrafts.push({ el: textarea, question: (labelTextFor(block) || label).slice(0, 200) });
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
  // flagging each as it resolves. If a draft fails or returns nothing, fall back to leaving it
  // blank plus the skip reason, unchanged.
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

  return { ats_name: 'greenhouse', fields_filled, fields_skipped, skipped_reasons };
}
