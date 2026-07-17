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
  setNativeValue,
  splitName,
  isComboboxControl,
  isReactManagedNode,
  openCombobox,
  pickComboOption,
  closeOpenCombobox,
  verifyFieldPersists,
} from './shared/dom';
import { matchCountryOption, splitInternationalPhone, type InternationalPhone } from './shared/phone';
// Reuse the generic adapter's pure answer-resolution engine so every adapter maps a question to
// the same answer and picks the same option. These are pure (no DOM) and covered by
// generic.answers.test.ts + ats-answer.test.ts.
import {
  classifyField,
  desiredAnswer,
  fitToBudget,
  isOpenEndedQuestion,
  isRefusedQuestion,
  linkQuestion,
  linkSkipReason,
  matchOption,
  WORK_ELIGIBILITY_QUESTION,
  workEligibilitySkipReason,
  type Desired,
} from './generic';

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

// ─── Phone country-code pairing (R-032, second defect) ────────────────────────

// Is this tel input wrapped by intl-tel-input? That widget is the measured mangler: fed the full
// international string in its NATIONAL number box, it reformatted "+971 567417451" into the local
// "056 741 7451", silently dropping the country code from what the employer receives.
function isInsideItiWidget(el: Element): boolean {
  return !!el.closest('.iti') || !!document.querySelector('[class*="iti__"], [id^="iti-"]');
}

// Does this control look like the phone's paired country/code selector, as opposed to any other
// select on the page? Either its identity says so, or (for a native select) its options print
// dialing codes, which nothing else does.
function looksLikeCountryCodeControl(el: Element): boolean {
  const idn = `${el.id} ${el.getAttribute('name') ?? ''} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
  if (/country|dial|calling.code|intl/.test(idn)) return true;
  if (el instanceof HTMLSelectElement) {
    return [...el.options].slice(0, 40).some((o) => /\+\d{1,3}/.test(o.text));
  }
  return false;
}

// The country-code control PAIRED with this tel input, or null when the form doesn't have one
// (a single plain phone box, which still takes the full international string as before).
// Nearby-first: walk at most two ancestors of the tel input, so a residence-country dropdown
// elsewhere on the form can't be mistaken for the phone pairing. The #country fallback is the
// id measured live on job-boards.greenhouse.io (Cresta, 2026-07-17) and is only trusted when
// the intl-tel-input widget is present too - that widget existing IS the evidence the phone
// field is country-paired, and without it a lone #country is more plausibly a residence field.
function findPhoneCountryControl(telEl: HTMLElement): HTMLElement | null {
  let scope: HTMLElement | null = telEl.parentElement;
  for (let depth = 0; scope && depth < 2; depth++, scope = scope.parentElement) {
    for (const cand of scope.querySelectorAll<HTMLElement>('select, [role="combobox"], [aria-haspopup="listbox"]')) {
      if (cand === telEl || cand.contains(telEl)) continue;
      if (looksLikeCountryCodeControl(cand)) return cand;
    }
  }
  const byId = document.getElementById('country');
  if (byId && byId !== telEl && looksLikeCountryCodeControl(byId) && isInsideItiWidget(telEl)) {
    return byId as HTMLElement;
  }
  return null;
}

// Drive the paired selector to the phone's own country. Returns false (and never guesses) when
// no unambiguous option matches - the caller must then refuse the number fill entirely, because
// a national number under the WRONG country code is a different phone number.
async function setPhoneCountry(control: HTMLElement, phone: InternationalPhone): Promise<boolean> {
  if (control instanceof HTMLSelectElement) {
    const options = [...control.options]
      .filter((o) => o.value)
      .map((o) => ({ text: o.text, value: o.value }));
    const m = matchCountryOption(options, phone);
    if (!m) return false;
    await randomDelay();
    // Native setter + events, not a bare .value: the new board's selects are React-controlled.
    setNativeValue(control, m.value);
    return true;
  }
  if (isComboboxControl(control)) {
    const options = await openCombobox(control, phone.countryNames[0]);
    if (options.length === 0) { closeOpenCombobox(); return false; }
    const m = matchCountryOption(options, phone);
    if (!m) { closeOpenCombobox(); return false; }
    await pickComboOption(m);
    return true;
  }
  return false;
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
  // R-033: the drafter's reach is no longer textarea-shaped. An entry may be a single-line text
  // input, which carries a character budget (maxLen) the draft must genuinely fit, and a
  // required flag so a failed draft is reported as the required blank it is.
  const pendingDrafts: Array<{
    el: HTMLTextAreaElement | HTMLInputElement;
    question: string;
    maxLen?: number;
    required?: boolean;
  }> = [];

  // R-032: every text write is recorded here and re-verified before the counts are final. The
  // card's number must describe the DOM at count time, not the adapter's intent - on the new
  // React board a pre-hydration write is silently reverted by hydration, which is how "Filled 5
  // fields" shipped over an empty First/Last/Email. The verify pass (bottom of this function)
  // re-fills what hydration wiped and un-counts what would not stick.
  const tracked: Array<{
    el: HTMLInputElement | HTMLTextAreaElement;
    value: string;
    what: string;
    drafted?: boolean;
  }> = [];
  const fillTracked = async (
    el: HTMLInputElement | HTMLTextAreaElement,
    value: string,
    what: string,
    drafted = false,
  ): Promise<void> => {
    await fillField(el, value);
    tracked.push({ el, value, what, drafted });
  };

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
    await fillTracked(firstEl, splitName(fullName).first, 'first name');
    fields_filled++;
  }
  if (lastEl && !lastEl.value && fullName) {
    await fillTracked(lastEl, splitName(fullName).last, 'last name');
    fields_filled++;
  }
  if (emailEl && !emailEl.value) {
    if (email) {
      await fillTracked(emailEl, email, 'email');
      fields_filled++;
    } else {
      fields_skipped++;
      skipped_reasons.push('email: not present in stored profile');
    }
  }
  // Phone, hydration's sibling defect: this form may split phone into a country-code selector
  // plus a NATIONAL number box (Cresta's #country + intl-tel-input, 2026-07-17), and typing the
  // full international string into the national box let the widget rewrite "+971 567417451" as
  // the local "056 741 7451" - digits rearranged, country code gone, silently. So: when the
  // stored number declares a country (+prefix) and the form has the paired control, set the
  // country there and put only the national number in the box. When the pairing exists but the
  // country cannot be matched, REFUSE and flag - a blank box the student fills beats a mangled
  // number they don't notice. A form with one plain phone box keeps today's behavior exactly.
  if (phoneEl && applicationProfile.phone) {
    const split = splitInternationalPhone(applicationProfile.phone);
    const countryControl = split ? findPhoneCountryControl(phoneEl) : null;
    if (split && countryControl) {
      if (await setPhoneCountry(countryControl, split)) {
        // Counted as ONE field: the selector and the number box are one phone question.
        await fillTracked(phoneEl, split.national, 'phone');
        fields_filled++;
      } else {
        fields_skipped++;
        skipped_reasons.push(
          `phone left for you: no option for +${split.dialCode} in this form's country-code selector (left blank rather than dropping the code)`,
        );
      }
    } else if (split && isInsideItiWidget(phoneEl)) {
      // The reformatting widget is present but its country control eluded detection. Typing the
      // international string here is the exact measured mangle, so hand the field back instead.
      fields_skipped++;
      skipped_reasons.push(
        'phone left for you: this form reformats phone numbers and its country-code control could not be driven',
      );
    } else {
      await fillTracked(phoneEl, applicationProfile.phone, 'phone');
      fields_filled++;
    }
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
      await fillTracked(cityEl, applicationProfile.address_city, 'location');
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
          await fillTracked(linkEl, link.url, `link field "${label.slice(0, 40)}"`);
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
          await fillTracked(textEl, known.value, `"${label.slice(0, 40)}"`);
          fields_filled++;
          continue;
        }
      }
      fields_skipped++;
      skipped_reasons.push(`${label.slice(0, 40)}: no matching control, left blank`);
      continue;
    }

    // Open-ended screening questions: draft via the hook if available (flagged for review), else
    // leave blank WITH a reason. A textarea keeps its budget when the author set one.
    const textarea = block.querySelector<HTMLTextAreaElement>('textarea');
    if (textarea && !textarea.value) {
      if (draftAnswer) {
        pendingDrafts.push({
          el: textarea,
          question: (labelTextFor(block) || label).slice(0, 200),
          maxLen: textarea.maxLength > 0 ? textarea.maxLength : undefined,
        });
      } else {
        fields_skipped++;
        skipped_reasons.push(`open-ended question left blank: "${label.slice(0, 60)}"`);
      }
      continue;
    }
    // R-033: Greenhouse lets an author render an open-ended question as a single-line
    // input[type=text] (Gemini asked for "3-5 sentences" in a 255-char input), and the drafter's
    // textarea-shaped reach silently never saw it - a REQUIRED field left blank with the card
    // claiming completeness. Two changes, in order of importance:
    //   1. FLAG, always: an empty text input here gets a skip reason, and a required one says
    //      "required" so the card can surface it first (content.ts sorts required blanks ahead
    //      of the cap). The card must never read as complete over an empty required control.
    //   2. DRAFT, narrowly: only a REQUIRED input whose label reads as a prose question
    //      (isOpenEndedQuestion), maps to NO profile field (classifyField null - so a salary or
    //      DOB box with no stored value stays an always-ask blank, never a drafted guess) and is
    //      no refused question (work-auth/EEO were intercepted above, this is belt and braces).
    //      The draft carries the input's maxLength as a hard budget - see the draft loop.
    const textInput = block.querySelector<HTMLInputElement>('input[type="text"]');
    // A field this run already wrote can read as empty HERE if hydration wiped it between the
    // write and this loop - it is not an open-ended blank, it is the verify pass's problem
    // (which will re-fill it or report it honestly). Without this guard the hydration race
    // makes First Name show up as a "required open-ended question left blank".
    if (textInput && !textInput.value && !tracked.some((t) => t.el === textInput)) {
      const required =
        textInput.required || textInput.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label);
      const draftable =
        required &&
        !!draftAnswer &&
        !isComboboxControl(textInput) &&
        isOpenEndedQuestion(label) &&
        !isRefusedQuestion(label) &&
        classifyField(label) === null;
      if (draftable) {
        pendingDrafts.push({
          el: textInput,
          question: (labelTextFor(block) || label).slice(0, 200),
          // A single-line answer needs a budget even when the author forgot maxlength.
          maxLen: textInput.maxLength > 0 ? textInput.maxLength : 400,
          required,
        });
      } else {
        fields_skipped++;
        skipped_reasons.push(`${required ? 'required ' : ''}open-ended question left blank: "${label.slice(0, 60)}"`);
      }
    }
  }

  // Draft every collected answer CONCURRENTLY (each is an independent LLM round trip), writing
  // and flagging each as it resolves. If a draft fails, returns nothing, or cannot fit the
  // control's budget as whole sentences, fall back to leaving it blank plus the skip reason.
  if (pendingDrafts.length > 0 && draftAnswer) {
    let pendingEssays = pendingDrafts.length;
    onProgress?.({ fields_filled, fields_skipped, ai_drafted, pendingEssays });
    await Promise.all(
      pendingDrafts.map(async ({ el, question, maxLen, required }) => {
        // A budgeted control tells the drafter up front (the backend prompt takes the question
        // as free context), because asking for an essay and then trimming it is how a 950-char
        // Notion-style draft meets a 255-char box. The constraint rides inside the question
        // string since that is the whole contract of /application/answer's payload.
        const constrained = maxLen
          ? `${question} [This is a short-answer field limited to ${maxLen} characters. Answer in 1-3 complete sentences that fit within that limit.]`
          : question;
        let drafted: string | null = null;
        try {
          drafted = (await draftAnswer(constrained))?.trim() || null;
        } catch {
          drafted = null;
        }
        // A single-line input cannot hold newlines; a model that answered in paragraphs anyway
        // gets flattened to one line before the budget check.
        if (drafted && el instanceof HTMLInputElement) drafted = drafted.replace(/\s*\n+\s*/g, ' ');
        // Hard budget: never write a mid-word or mid-clause clip (the R-029 family - a sentence
        // that ends mid-thought misrepresents her). fitToBudget keeps whole sentences or
        // surrenders the field to the student.
        if (drafted && maxLen) drafted = fitToBudget(drafted, maxLen);
        if (drafted) {
          await fillTracked(el, drafted, `drafted answer "${question.slice(0, 40)}"`, true);
          markForReview(el);
          ai_drafted++;
          fields_filled++;
        } else {
          fields_skipped++;
          skipped_reasons.push(`${required ? 'required ' : ''}open-ended question left blank: "${question.slice(0, 60)}"`);
        }
        pendingEssays--;
        onProgress?.({ fields_filled, fields_skipped, ai_drafted, pendingEssays });
      }),
    );
  }

  // ─── R-032 verify pass: the counts describe the DOM, not the intent ─────────
  // Every text write is read back until it verifiably persists. On the new React board
  // (job-boards.greenhouse.io) a pre-hydration write is reverted by hydration; the verifier
  // detects the wipe, re-fills against the now-mounted component (the write R-007 proved
  // correct), and only then counts the field. A value that will not stick is un-counted and
  // reported with "left for you", which both puts it on the card's "Still needs you" list and
  // holds auto-submit (REVIEW_FLAG). Runs for all writes in parallel, so wall clock is one
  // field's window, and exits early on the framework signal instead of sleeping a fixed time.
  // Comboboxes/radios/files are not re-verified here: they are committed by real click
  // sequences, and the measured revert class is text values only.
  if (tracked.length > 0) {
    const expectHydration =
      /(^|\.)job-boards\./.test(window.location.hostname) || tracked.some((t) => isReactManagedNode(t.el));
    const outcomes = await Promise.all(
      tracked.map((t) => verifyFieldPersists(t.el, t.value, { expectHydration })),
    );
    outcomes.forEach((ok, i) => {
      if (ok) return;
      const t = tracked[i];
      fields_filled = Math.max(0, fields_filled - 1);
      if (t.drafted) ai_drafted = Math.max(0, ai_drafted - 1);
      fields_skipped++;
      skipped_reasons.push(`${t.what} left for you: the page did not keep the value RoleQuick wrote`);
    });
  }

  if (ai_drafted > 0) {
    skipped_reasons.unshift(`${ai_drafted} open-ended answer${ai_drafted === 1 ? '' : 's'} AI-drafted, review before submitting`);
  }

  return { ats_name: 'greenhouse', fields_filled, fields_skipped, ai_drafted, skipped_reasons };
}
