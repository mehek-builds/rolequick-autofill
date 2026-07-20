import type { ApplicationProfile, AutofillResult, Profile } from '../types';

// Lever field-mapping adapter (PRD-v2-resume-autofill.md Section 7). Lever is the recommended
// first ATS to ship (simple same-page form, static DOM, no cross-origin iframe like Greenhouse
// sometimes has). This fills what it can from the stored application profile + resume, skips
// anything it's told never to touch, and NEVER clicks Submit - Section 5 Step 4's one rule with
// zero tolerance for drift.

import {
  commitChoice,
  NEVER_FILL_LABEL_PATTERNS,
  randomDelay,
  fillField,
  isComboboxControl,
  openCombobox,
  pickComboOption,
  closeOpenCombobox,
  blockAlreadyAnswered,
  unattachableDocumentReasons,
} from './shared/dom';
import { gradeQuestion, gradeReviewReason, gradeSkipReason } from './grades';
import { isDraftTargetAvailable, runDraftQueue } from './shared/drafts';
// Reuse the generic adapter's pure answer-resolution engine so every adapter maps a question to
// the same answer and picks the same option. Pure (no DOM), covered by the adapter answer tests.
import { desiredAnswer, isDraftableQuestion, linkQuestion, linkSkipReason, locationQuestion, locationSkipReason, matchOption, noteLinkFillCandidate, unreadableQuestionSkipReason, WORK_ELIGIBILITY_QUESTION, workEligibilitySkipReason, type Desired } from './generic';

function labelTextFor(el: Element): string {
  const container = el.closest('.application-question, .card, li') ?? el.parentElement;
  return (container?.textContent ?? '').trim().toLowerCase();
}

function isNeverFillField(el: Element): boolean {
  const label = labelTextFor(el);
  return NEVER_FILL_LABEL_PATTERNS.some((re) => re.test(label));
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
// native radios, or a react-select combobox. Radio option text prefers the associated <label>,
// falling back to the value attribute.
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

export interface LeverFillParams {
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
  signal?: AbortSignal;
  onProgress?: (partial: { fields_filled: number; fields_skipped: number; ai_drafted: number; pendingEssays: number }) => void;
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
  const { fullName, email, profile, applicationProfile, resumeBlob, resumeFileName, draftAnswer, onProgress } = params;
  const eeo = params.eeo ?? {};
  let fields_filled = 0;
  let fields_skipped = 0;
  let ai_drafted = 0;
  const skipped_reasons: string[] = [];
  const pendingDrafts: Array<{ el: HTMLTextAreaElement; question: string }> = [];

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
  // `profile.experience` is typed as a required array but comes from a jsonb `parsed_json` blob
  // with no runtime guarantee; optional-chain the whole path so a profile that parsed without an
  // experience array doesn't throw and get mis-reported to the student as a fill timeout.
  if (orgEl && profile.experience?.[0]?.company) {
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

  // Documents this form requires that RoleQuick cannot produce (R-010). Reported at fill time, in
  // the card, so the student learns the form wants a transcript NOW rather than at submit; the
  // "left for" wording holds auto-submit while it sits unattached.
  const documentReasons = unattachableDocumentReasons(resumeEl);
  fields_skipped += documentReasons.length;
  skipped_reasons.push(...documentReasons);

  // Eligibility and screening questions (PRD-v2 Section 4B). Work authorization AND sponsorship
  // are deliberately NEVER answered and hold auto-submit (see WORK_ELIGIBILITY_QUESTION in
  // generic.ts). Lever renders these as custom "additional questions" with no stable name
  // attribute, so match on label text.
  const questionBlocks = document.querySelectorAll('.application-question, .card');
  for (const block of questionBlocks) {
    if (isNeverFillField(block)) {
      fields_skipped++;
      skipped_reasons.push('never-fill field (SSN/license/background-check consent), left for manual entry');
      continue;
    }

    const label = labelTextFor(block);
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
      const locEl = block.querySelector<HTMLInputElement>('input[type="text"]');
      if (locEl && !isComboboxControl(locEl)) {
        await fillField(locEl, loc.value);
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

    // Link questions ("provide a link to your GitHub"). Lever has no stable name attribute for
    // these custom questions - the urls[LinkedIn]/urls[GitHub] selectors above only cover Lever's
    // OWN standard link fields - so a custom link question used to fall straight through to the
    // AI drafter and come back as a prose paragraph (live QA 2026-07-16, Xsolla's GitHub field).
    // Placed AFTER the known-answer branch so a referral question whose options mention LinkedIn
    // resolves as referral, and BEFORE the open-ended branch so the drafter can never see it.
    const link = linkQuestion(label, applicationProfile);
    if (link) {
      // The textarea is the control that reached the drafter, so it must be reachable here - but
      // only when the label asks for a link, or "tell us about your portfolio" would get answered
      // with a bare URL instead of the essay it wants.
      const linkEl: HTMLInputElement | HTMLTextAreaElement | null =
        block.querySelector<HTMLInputElement>('input[type="text"], input[type="url"]') ??
        (link.asksForLink ? block.querySelector<HTMLTextAreaElement>('textarea') : null);
      // R-030 observation only (see generic.ts): record the labels that fill a URL unconditionally.
      noteLinkFillCandidate(label, link, linkEl);
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

  // Draft through the shared bounded worker pool, writing and flagging each answer as it resolves.
  if (pendingDrafts.length > 0 && draftAnswer) {
    await runDraftQueue({
      items: pendingDrafts,
      draftAnswer,
      signal: params.signal,
      promptFor: ({ question }) => question,
      onSettled: async ({ el, question }, drafted) => {
        if (!isDraftTargetAvailable(el)) return;
        if (drafted) {
          const written = await fillField(
            el,
            drafted,
            () => !params.signal?.aborted && isDraftTargetAvailable(el),
          );
          if (!written) return;
          markForReview(el);
          ai_drafted++;
          fields_filled++;
        } else {
          fields_skipped++;
          skipped_reasons.push(`open-ended question left blank: "${question.slice(0, 60)}"`);
        }
      },
      onProgress: (pendingEssays) =>
        onProgress?.({ fields_filled, fields_skipped, ai_drafted, pendingEssays }),
    });
  }

  if (ai_drafted > 0) {
    skipped_reasons.unshift(`${ai_drafted} open-ended answer${ai_drafted === 1 ? '' : 's'} AI-drafted, review before submitting`);
  }

  return { ats_name: 'lever', fields_filled, fields_skipped, ai_drafted, skipped_reasons };
}
