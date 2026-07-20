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

import {
  commitChoice,
  NEVER_FILL_LABEL_PATTERNS,
  randomDelay,
  setNativeValue,
  fillField,
  splitName,
  isComboboxControl,
  openCombobox,
  pickComboOption,
  closeOpenCombobox,
  blockAlreadyAnswered,
  firstNonEmptyText,
  unattachableDocumentReasons,
} from './shared/dom';
import { gradeQuestion, gradeReviewReason, gradeSkipReason } from './grades';
import { runDraftQueue } from './shared/drafts';
// Reuse the generic adapter's pure answer-resolution engine so every adapter maps a question to
// the same answer and picks the same option. Pure (no DOM), covered by the adapter answer tests.
import { desiredAnswer, isDraftableQuestion, linkQuestion, linkSkipReason, locationQuestion, locationSkipReason, matchOption, noteLinkFillCandidate, unreadableQuestionSkipReason, WORK_ELIGIBILITY_QUESTION, workEligibilitySkipReason, type Desired } from './generic';

// ─── Shared answer helpers (mirror generic.ts's engine) ───────────────────────

// Drive a Workday prompt / react-select listbox to the desired answer: open it, read the rendered
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

// Workday renders many choices as a "prompt" button that opens a listbox popup, plus the usual
// react-select controls; both are covered here.
function comboControlIn(block: Element): HTMLElement | null {
  return block.querySelector<HTMLElement>(
    'input[role="combobox"], [role="combobox"], [aria-haspopup="listbox"], button[aria-haspopup="listbox"], [class*="select__control"], [class*="Select-control"]',
  );
}

// Answer a question block that resolved to a known desired value, across a native <select>,
// native radios, or a Workday prompt / react-select combobox. Radio option text prefers the
// associated <label>, falling back to the value attribute.
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

// 2026-07-03: RoleQuick never creates the Workday account itself (backend-driven third-party
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
  // Prefer Workday's resume dropzone. If we must fall back to a bare file input, skip one that is
  // clearly a cover-letter/other-docs uploader - Workday pages can carry several file inputs, and a
  // blind `input[type="file"]` grab could attach the resume to the wrong slot.
  const input =
    document.querySelector<HTMLInputElement>(
      '[data-automation-id="file-upload-drop-zone"] input[type="file"], [data-automation-id*="resumeUpload" i] input[type="file"]',
    ) ??
    [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].find((el) => {
      const ctx = `${el.getAttribute('data-automation-id') ?? ''} ${
        el.closest('[data-automation-id]')?.getAttribute('data-automation-id') ?? ''
      } ${el.closest('div,section,fieldset')?.textContent?.slice(0, 120) ?? ''}`.toLowerCase();
      return !/cover\s*letter/.test(ctx);
    }) ??
    null;
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
  // (not always a real <label for=...>).
  const container = el.closest('[data-automation-id$="Section"], fieldset, li') ?? el.parentElement;
  // Prefer a discrete question label over the entire container's text: one Workday section can wrap
  // several questions, and gluing them into one string lets a control match a NEIGHBOURING
  // question's keywords (e.g. an EEO term bleeding into a work-auth block, or auth vs sponsorship
  // colliding). Fall back to full text only when no legend/label exists.
  // Workday already had the empty-source fall-through right (it tests the TRIMMED string, not the
  // element), which is why it escaped R-006. Routed through the shared helper anyway so the one
  // adapter that got it right cannot drift back to the `??` form the others were fixed out of.
  return firstNonEmptyText(
    container?.querySelector('legend')?.textContent,
    container?.querySelector('label, [data-automation-id="formLabel"], [data-automation-id="richText"]')?.textContent,
    container?.textContent,
  );
}

function isNeverFillField(el: Element): boolean {
  return NEVER_FILL_LABEL_PATTERNS.some((re) => re.test(labelTextFor(el)));
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

export interface WorkdayFillParams {
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

export async function fillWorkdayApplication(params: WorkdayFillParams): Promise<AutofillResult> {
  const { fullName, email, applicationProfile, resumeBlob, resumeFileName, draftAnswer, onProgress } = params;
  const eeo = params.eeo ?? {};
  let fields_filled = 0;
  let fields_skipped = 0;
  let ai_drafted = 0;
  const skipped_reasons: string[] = [];
  const pendingDrafts: Array<{ el: HTMLTextAreaElement; question: string }> = [];

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

  // Documents this form requires that RoleQuick cannot produce (R-010). Reported at fill time, in
  // the card, so the student learns the form wants a transcript NOW rather than at submit; the
  // "left for" wording holds auto-submit while it sits unattached.
  const documentReasons = unattachableDocumentReasons();
  fields_skipped += documentReasons.length;
  skipped_reasons.push(...documentReasons);

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

    // Link questions, via the one shared classifier (see linkQuestion in generic.ts). Replaces an
    // inline version that let an unset URL fall through to the AI drafter and never looked at a
    // textarea - the two holes behind the Lever prose-in-a-link-field bug.
    const link = linkQuestion(label, applicationProfile);
    if (link) {
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
      // control is a native select, native radios, or a Workday prompt / react-select combobox.
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
      promptFor: ({ question }) => question,
      onSettled: async ({ el, question }, drafted) => {
        if (drafted) {
          await fillField(el, drafted);
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

  return { ats_name: 'workday', fields_filled, fields_skipped, ai_drafted, skipped_reasons };
}

export interface WorkdayAccountCreationParams {
  email?: string;
}

// Fills only the email field and stops - password is deliberately never touched here (2026-07-03
// product decision: the student sets and enters their own password, clicks Create Account, and
// completes email verification entirely on their own). This is the one RoleQuick-fillable field on
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

  return { ats_name: 'workday', fields_filled, fields_skipped, ai_drafted: 0, skipped_reasons };
}
