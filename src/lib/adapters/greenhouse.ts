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
  blockAlreadyAnswered,
  firstNonEmptyText,
} from './shared/dom';
import { gradeQuestion, gradeReviewReason, gradeSkipReason } from './grades';
// Reuse the generic adapter's pure answer-resolution engine so every adapter maps a question to
// the same answer and picks the same option. These are pure (no DOM) and covered by
// generic.answers.test.ts + ats-answer.test.ts.
import { desiredAnswer, isDraftableQuestion, linkQuestion, linkSkipReason, locationQuestion, locationSkipReason, matchOption, unreadableQuestionSkipReason, WORK_ELIGIBILITY_QUESTION, workEligibilitySkipReason, type Desired } from './generic';

function labelTextFor(el: Element): string {
  const container = el.closest('.field-wrapper, .field, #custom_fields > div, li') ?? el.parentElement;
  // Falls through when the <label> exists but renders empty, instead of resolving the question to
  // "" (R-006). `??` could not do this: "" is non-null, so it never reached the container fallback.
  return firstNonEmptyText(container?.querySelector('label')?.textContent, container?.textContent);
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
// `note` exists because not everything flagged for review is an AI draft. A converted
// grade (R-005) is a deterministic band mapping, not model output, and calling it an "AI
// draft" would tell the student an LLM invented their GPA.
function markForReview(el: HTMLElement, note = 'AI draft: review before submitting'): void {
  el.style.outline = '2px solid #f59e0b';
  el.style.outlineOffset = '1px';
  const badge = document.createElement('div');
  badge.textContent = note;
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

// Has this block already been answered? The grade branch needs it for the same reason the location
// branch does: an earlier pass or a pre-filled form must not be overwritten.
function blockAlreadyAnsweredForGrade(block: Element): boolean {
  const text = block.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    'input[type="text"], input[type="number"], textarea',
  );
  if (text?.value.trim()) return true;
  if (block.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked')) return true;
  const select = block.querySelector<HTMLSelectElement>('select');
  if (select?.value) return true;
  return !!block.querySelector('[class*="singleValue"], [class*="multiValue"]');
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
  // #candidate-location is the current template's id, but a Greenhouse EMBED on a company's own
  // careers page renders its own markup - live QA 2026-07-16 (Monzo, Global Relay) hit forms where
  // this single id matched nothing, so the field was skipped with no fill AND no skip reason. The
  // label-driven location branch in the block loop below is the real backstop; these extra
  // selectors just catch the common named shapes before it.
  const cityEl = firstMatch<HTMLInputElement>([
    '#candidate-location',
    '#job_application_location',
    'input[name="job_application[location]"]',
    'input[autocomplete="address-level2"]',
  ]);
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

    // Link questions, via the one shared classifier (see linkQuestion in generic.ts). The old
    // inline version here had the same two holes that let Lever answer a GitHub-link field with a
    // prose paragraph: an unset URL collapsed to `undefined` and fell through to the AI drafter,
    // and the selector never looked at a textarea, which is the only control that reaches it.
    const link = linkQuestion(label, applicationProfile);
    if (link) {
      const linkEl: HTMLInputElement | HTMLTextAreaElement | null =
        block.querySelector<HTMLInputElement>('input[type="text"], input[type="url"]') ??
        (link.asksForLink ? block.querySelector<HTMLTextAreaElement>('textarea') : null);
      if (linkEl && !linkEl.value && !isComboboxControl(linkEl)) {
        if (link.url) {
          await fillField(linkEl, link.url);
          fields_filled++;
        } else {
          fields_skipped++;
          skipped_reasons.push(linkSkipReason(label));
        }
        continue;
      }
    }

    // Never answer work-eligibility questions (work authorization AND sponsorship), on any
    // control type: one shared classifier and reason builder for every adapter (see
    // WORK_ELIGIBILITY_QUESTION in generic.ts for the full story). Checked BEFORE the EEO branch
    // so a block that also carries an EEO keyword cannot be routed to a decline answer or a
    // mislabeled skip reason.
    if (WORK_ELIGIBILITY_QUESTION.test(label)) {
      fields_skipped++;
      skipped_reasons.push(workEligibilitySkipReason(label));
      continue;
    }

    // Location of residence (city/state/country), via the one shared classifier (see
    // locationQuestion in generic.ts). Placed AFTER the work-eligibility branch so a legal
    // "authorized to work in X?" question is already gone by the time we look for a country -
    // locationQuestion guards that internally too, but the ordering means a regression in either
    // one alone cannot resurrect the R-004 false declaration.
    // ALWAYS terminates the block, which is the fix: a location question we cannot answer now
    // leaves a "left for you" reason that HOLDS auto-submit and shows in the card, instead of
    // falling through to be left blank silently and bounce at submit (R-002, 3/12 live forms).
    const loc = locationQuestion(label, applicationProfile);
    if (loc && !blockAlreadyAnswered(block)) {
      if (!loc.value) {
        fields_skipped++;
        skipped_reasons.push(locationSkipReason(loc.field, label, 'no-value'));
        continue;
      }
      if (await answerChoiceBlock(block, { mode: 'value', value: loc.value })) {
        fields_filled++;
        continue;
      }
      const textEl = block.querySelector<HTMLInputElement>('input[type="text"]');
      if (textEl && !isComboboxControl(textEl)) {
        await fillField(textEl, loc.value);
        fields_filled++;
        continue;
      }
      fields_skipped++;
      skipped_reasons.push(locationSkipReason(loc.field, label, 'no-option'));
      continue;
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


    // Academic record (R-005): GPA / grade average / degree classification / major. Placed with the
    // other known-answer classifiers and, like them, ALWAYS terminates the block so an unanswerable
    // one is flagged rather than silently left blank.
    // A CONVERTED answer (a form asking for a scale we don't store) is filled AND flagged: the
    // review flag is the whole reason converting is defensible at all, so it is not optional here.
    const grade = gradeQuestion(label, applicationProfile);
    if (grade && !blockAlreadyAnsweredForGrade(block)) {
      if (!grade.value) {
        fields_skipped++;
        skipped_reasons.push(gradeSkipReason(grade.field, label));
        continue;
      }
      const gradeDesired: Desired = { mode: 'value', value: grade.value };
      let wrote = await answerChoiceBlock(block, gradeDesired);
      if (!wrote) {
        const gradeEl = block.querySelector<HTMLInputElement>('input[type="text"], input[type="number"]');
        if (gradeEl && !isComboboxControl(gradeEl)) {
          await fillField(gradeEl, grade.value);
          wrote = true;
        }
      }
      if (!wrote) {
        fields_skipped++;
        skipped_reasons.push(gradeSkipReason(grade.field, label));
        continue;
      }
      fields_filled++;
      if (grade.needsReview) {
        const reviewEl = block.querySelector<HTMLElement>('input, select, textarea');
        if (reviewEl) markForReview(reviewEl, 'Converted grade: check this before submitting');
        skipped_reasons.push(gradeReviewReason(label, grade.disclosure));
      }
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
      if (!isDraftableQuestion(label)) {
        // An unreadable label must never reach the drafter: the backend requires a non-empty
        // question (z.string().min(1)), so "" is a guaranteed 400, a null draft, and a REQUIRED
        // essay left blank with nobody told. Flag it so auto-submit holds (R-006).
        fields_skipped++;
        skipped_reasons.push(unreadableQuestionSkipReason());
      } else if (draftAnswer) {
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

  return { ats_name: 'greenhouse', fields_filled, fields_skipped, ai_drafted, skipped_reasons };
}
