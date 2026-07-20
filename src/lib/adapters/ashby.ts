import type { ApplicationProfile, AutofillResult, Profile } from '../types';

// Ashby field-mapping adapter (PRD-v2-resume-autofill.md Section 7, build-order step 3).
// Ashby's built-in identity fields use a stable `_systemfield_*` name-attribute convention
// across every board (name, email); everything else - links, work-auth, EEO, custom screening
// questions - gets a per-posting generated name/id, so those are matched by label text, same
// defensive pattern as Lever and Greenhouse.
//
// Verified 2026-07-01 against a live posting (jobs.ashbyhq.com/notion, Software Engineer Intern
// application): two real bugs live testing caught.
//
// 1. There are TWO file inputs on the page: Ashby's own "autofill from resume" parser widget
//    (used to pre-fill the form from an uploaded resume, id/name both empty) comes FIRST in DOM
//    order, and the actual application resume field (id="_systemfield_resume") comes second. A
//    generic `input[type="file"]` selector would grab the parser widget, silently leaving the
//    real resume field empty. Fixed by targeting `#_systemfield_resume` directly.
//
// 2. Every radio input's `value` attribute is literally "on" (the browser default for an
//    unvalued input) - the real answer text lives in an associated `<label for="...">`, not the
//    value. Matching `input[value="Yes"]` never matches anything on Ashby. Fixed by reading
//    `label[for=radio.id]` text for every option in a radio group. Also found: not every
//    yes/no-shaped question IS binary - a sponsorship question rendered as J1/F1/None/Other,
//    which `applicationProfile.needs_sponsorship` (a boolean) can't confidently answer, so the
//    matcher only fills when it finds a single option whose label clearly means yes/no/none,
//    and skips (never guesses a visa type) otherwise.
//
// The other Ashby-specific risk (Section 7's table): the form is React-rendered and can
// re-render on input, which invalidates element references taken before a fill. Every helper
// here re-queries the DOM immediately before touching it (never holds a stale reference across
// an await), and waitForStableDom() pauses between fields until mutations stop rather than
// firing every field in one tight loop.

import {
  commitChoice,
  NEVER_FILL_LABEL_PATTERNS,
  randomDelay,
  setNativeValue,
  radioOptionsIn,
  isComboboxControl,
  isPhoneLabel,
  openCombobox,
  pickComboOption,
  closeOpenCombobox,
  blockAlreadyAnswered,
  driveAsyncLocationCombobox,
  firstNonEmptyText,
  unattachableDocumentReasons,
} from './shared/dom';
import { gradeQuestion, gradeReviewReason, gradeSkipReason } from './grades';
// Reuse the generic adapter's pure answer-resolution engine so every adapter maps a question to
// the same answer and picks the same option. Pure (no DOM), covered by the adapter answer tests.
import { classifyField, dateSkipReason, desiredAnswer, fillDateField, isDraftableQuestion, languageAnswerPlan, languageSkipReason, linkQuestion, linkSkipReason, locationComboQueries, locationQuestion, locationSkipReason, matchOption, noteLinkFillCandidate, unreadableQuestionSkipReason, WORK_ELIGIBILITY_QUESTION, workEligibilitySkipReason, type Desired } from './generic';
// The salary rule (R-031 + R-011) and the Ashby posting-API pieces live in the pure salary
// module, shared with background.ts (which fetches the compensation payload) and re-exported
// below so existing importers of parseAshbyPostingRef keep working.
import { parseAshbyPostingRef, resolveSalary, salarySkipReason, storedSalaryOf, type AshbyPostingRef, type PostingCompensation } from './salary';
import { isDateControl } from './shared/dates';
import { htmlToPlainText, JD_UNREADABLE, looksLikeJobDescription } from './shared/jd';
import { runDraftQueue } from './shared/drafts';

// Resolves once the DOM has gone quiet for `quietMs`, or after `maxMs` regardless - Ashby's
// React tree re-renders after most field changes, and firing the next fill mid-re-render risks
// writing into a node about to be replaced.
function waitForStableDom(quietMs = 200, maxMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      clearTimeout(hardTimeout);
      resolve();
    };
    let quietTimer = setTimeout(finish, quietMs);
    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    const hardTimeout = setTimeout(finish, maxMs);
  });
}

// Verified live: `fieldset[class*="_fieldEntry_"]` is the per-question container for BOTH radio
// groups and text inputs. A generic `[class*="_container_"]` ancestor is too broad - it can wrap
// several unrelated questions together, mixing their radios in one lookup. Prefer <legend> (used
// on radio-group fieldsets) over full textContent, which would otherwise include every option's
// label text glued onto the question text.
function labelTextFor(el: Element): string {
  const entry = el.closest('fieldset[class*="_fieldEntry_"], div[class*="_fieldEntry_"]');
  const container = entry ?? el.closest('[class*="_container_"], li') ?? el.parentElement;
  // Prefer a discrete <legend> (radio-group fieldsets), then a real <label> (div-based text
  // entries), then the container's full text. Each source now falls through when it renders EMPTY,
  // not only when it is absent: an entry whose <legend> exists but is blank used to resolve the
  // whole question to "" and never look at the <label> beneath it (R-006, live QA 2026-07-16).
  return firstNonEmptyText(
    entry?.querySelector('legend')?.textContent,
    entry?.querySelector('label')?.textContent,
    container?.textContent,
  );
}

function isNeverFillField(el: Element): boolean {
  const label = labelTextFor(el);
  return NEVER_FILL_LABEL_PATTERNS.some((re) => re.test(label));
}

// Write text into an Ashby (React-controlled) input the way the rest of this adapter does: pace it,
// focus, set through the native setter, blur, then let the re-render settle before the next write.
// Deliberately NOT shared/dom's fillField, which omits the waitForStableDom - Ashby re-renders
// after most field changes and the next fill can land in a node that is about to be replaced.
async function writeReactText(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await randomDelay();
  el.focus();
  setNativeValue(el, value);
  el.blur();
  await waitForStableDom();
}

// ─── Shared answer helpers (mirror generic.ts's engine) ───────────────────────

// Drive a react-select / listbox combobox to the desired answer: open it, read the rendered
// options, click the confident match. Returns false (never guesses) when the menu never opens or
// no option matches, dismissing any open portal first.
async function fillCombobox(trigger: HTMLElement, desired: Desired): Promise<boolean> {
  if (!desired) return false;
  const typeahead =
    desired.mode === 'value' ? desired.value : desired.mode === 'oneof' ? desired.values[0] : undefined;
  const options = await openCombobox(trigger, typeahead);
  if (options.length === 0) { closeOpenCombobox(); return false; }
  const match = matchOption(options, desired);
  if (!match) { closeOpenCombobox(); return false; }
  await pickComboOption(match);
  await waitForStableDom();
  return true;
}

function comboControlIn(block: Element): HTMLElement | null {
  return block.querySelector<HTMLElement>(
    'input[role="combobox"], [role="combobox"], [aria-haspopup="listbox"], [class*="select__control"], [class*="Select-control"]',
  );
}

// Ashby renders some single-choice questions (sponsorship, eligibility, some EEO) as a row of
// plain <button> option pills - no radio input, no role - live-seen as `<button>Yes</button>` /
// `<button>No</button>`. Collect those buttons so they can be matched by text and clicked, while
// excluding action buttons (upload/submit/remove/etc.) that also live in the block.
//
// Do NOT filter by `b.type !== 'submit'`: a <button> with no `type` attribute reports
// `.type === 'submit'` by HTML default, which is exactly what these option pills are - excluding
// them here is why the sponsorship Yes/No never filled (verified live on Ashby). The form's real
// submit control is already excluded by the text list below (it reads "Submit application").
function buttonOptionsIn(block: Element): Array<{ text: string; el: HTMLButtonElement }> {
  return [...block.querySelectorAll<HTMLButtonElement>('button')]
    .filter((b) => !b.closest('[id*="rolequick"]'))
    .map((b) => ({ text: (b.textContent ?? '').trim(), el: b }))
    .filter(
      (b) =>
        b.text.length > 0 &&
        b.text.length <= 40 &&
        !/upload|replace|drag|drop|submit|browse|remove|delete|\bsave\b|cancel|\+\s*add/i.test(b.text),
    );
}

// Answer a question block that resolved to a known desired value, across a native <select>,
// native radios (value is always "on" on Ashby, so match by the associated <label>), or a
// react-select combobox. Every path lets the React tree settle before returning.
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
      await waitForStableDom();
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

  // "Select all that apply" checkbox groups (Ashby renders EEO ethnicity / community questions
  // this way): tick the opt-out box for a decline, or the matching box for a value.
  const checkboxes = [...block.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    .filter((cb) => !cb.closest('[id*="rolequick"]') && !cb.disabled)
    .map((cb) => ({
      text: (
        document.querySelector(`label[for="${CSS.escape(cb.id)}"]`)?.textContent ??
        cb.closest('label')?.textContent ??
        cb.getAttribute('aria-label') ??
        ''
      ).trim(),
      el: cb,
    }));
  if (checkboxes.length > 0) {
    const m = matchOption(checkboxes, desired);
    if (m) {
      if (!m.el.checked) await checkRadio(m.el);
      return true;
    }
  }

  // Button-pill options (no radio/select): match by text and click. Ashby's option pills are
  // React-controlled, so a bare .click() can register visually (adds _active) but get reverted by
  // a later re-render during the fill - dispatch the full pointer sequence so the framework's
  // pointer/mouse handlers commit the selection, then verify it stuck and retry once if not.
  const buttons = buttonOptionsIn(block);
  if (buttons.length > 0) {
    const m = matchOption(buttons, desired);
    if (m) {
      await randomDelay();
      const opts = { bubbles: true, cancelable: true, view: window } as const;
      const press = () => {
        try { m.el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch { /* older engines */ }
        m.el.dispatchEvent(new MouseEvent('mousedown', opts));
        m.el.dispatchEvent(new MouseEvent('mouseup', opts));
        m.el.click();
      };
      press();
      await waitForStableDom();
      // A selected pill signals it via a class (_active/_selected/_checked), an ARIA state
      // (aria-pressed/checked/selected), or a data-state. Recognizing all of them matters: if the
      // first press DID take via a signal we don't check, stuck() would read false and we'd press a
      // second time and toggle the selection back OFF. Only retry on a still-connected node too, so a
      // re-render that detached the matched pill doesn't get a wasted second press.
      const stuck = () =>
        /_active|_selected|_checked/.test(m.el.className) ||
        m.el.getAttribute('aria-pressed') === 'true' ||
        m.el.getAttribute('aria-checked') === 'true' ||
        m.el.getAttribute('aria-selected') === 'true' ||
        /^(?:on|true|active|selected|checked)$/i.test(m.el.getAttribute('data-state') ?? '');
      if (!stuck() && m.el.isConnected) {
        press();
        await waitForStableDom();
      }
      return true;
    }
  }

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

async function checkRadio(radio: HTMLInputElement): Promise<void> {
  await randomDelay();
  // Ashby is React-controlled (hence waitForStableDom below); commitChoice clicks rather than
  // only poking .checked so the selection actually registers in component state.
  commitChoice(radio);
  await waitForStableDom();
}

async function fillBySelector(selector: string, value: string): Promise<boolean> {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!el || el.value) return false;
  await randomDelay();
  el.focus();
  setNativeValue(el, value);
  el.blur();
  await waitForStableDom();
  return true;
}

async function fillResumeFile(blob: Blob, fileName: string): Promise<boolean> {
  // #_systemfield_resume is the real application field; a generic `input[type="file"]` selector
  // would match Ashby's own resume-autofill-parser widget instead, which renders first in the DOM.
  const input = document.querySelector<HTMLInputElement>(
    '#_systemfield_resume, input[type="file"][name*="resume" i]',
  );
  if (!input) return false;
  await randomDelay();
  const file = new File([blob], fileName, { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await waitForStableDom();
  return true;
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

export interface AshbyFillParams {
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
  // This posting's structured salary range (R-031), fetched by background.ts from the posting API
  // (?includeCompensation=true) and plumbed through the GENERATE_RESUME_AND_FILL_DATA response.
  // Optional and nullable: a board whose slug does not resolve, or a posting with no usable
  // range, just leaves the salary rule on its label/stored-value chain.
  postingCompensation?: PostingCompensation | null;
}

export function isAshbyApplicationPage(): boolean {
  // Live-tested 2026-07-02 (jobs.ashbyhq.com/notion): the real apply-flow path is
  // "/application", not "/apply" - "/apply" alone never matched anything on this template and
  // the fill card never appeared. Both are checked in case older/other boards use "/apply".
  const path = window.location.pathname;
  return window.location.hostname.includes('ashbyhq.com') && (path.includes('/apply') || path.includes('/application'));
}

// ─── Job-description extraction (R-013) ─────────────────────────────────────
//
// On the Ashby Application tab - the only place the form and RoleQuick's card exist - the job
// description is NOT in the DOM at all. It lives on the Overview tab and is swapped out on SPA
// nav. The old extractor could not tell, so every Ashby resume was tailored to the job title and
// some form labels. See shared/jd.ts for the full failure write-up.
//
// The fix is a chain of real sources, each sanity-checked, rather than one selector plus a body
// fallback that hides its own failure:
//
//   1. Ashby's public posting API. Clean plaintext, a documented contract, no DOM archaeology and
//      nothing to break when Ashby renames a CSS class (which is exactly what bit the old
//      selector). Verified 2026-07-17 to send `access-control-allow-origin: *`, so it needs no
//      host_permissions and the install warning is unchanged.
//   2. The posting page's own bootstrap payload. The API does NOT resolve for every board (org
//      slugs that 404 were measured live), but every posting page - INCLUDING the /application
//      route - embeds `window.__appData` carrying `descriptionHtml`. A content script can't read
//      that off the main world, so we re-fetch the page same-origin and pull it out of the source.
//   3. The DOM, tightened. Last resort, and no longer able to pass off the body as a JD.
//
// If nothing yields something that reads like a job description, that is reported as its own
// distinct failure. Tailoring to junk is worse than not tailoring.

const MAX_JD_CHARS = 12000;

// `jobs.ashbyhq.com/espa/<uuid>[/application]` -> { org: 'espa', postingId: '<uuid>' }. The
// implementation moved to ./salary (the leaf module background.ts can import); re-exported here
// so this adapter stays the public home of the Ashby posting-URL contract.
export { parseAshbyPostingRef, type AshbyPostingRef } from './salary';

// Pick this posting out of the board payload. Matching on the id already in the page URL is exact;
// matching on title would break on a board running two postings with the same title.
export function selectPostingJd(payload: unknown, postingId: string): string | null {
  const jobs = (payload as { jobs?: Array<Record<string, unknown>> } | null)?.jobs;
  if (!Array.isArray(jobs)) return null;
  const job = jobs.find(
    (j) => j.id === postingId || (typeof j.jobUrl === 'string' && j.jobUrl.includes(postingId)),
  );
  const text = job?.descriptionPlain;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

async function fetchAshbyJdFromApi(ref: AshbyPostingRef): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(ref.org)}?includeCompensation=true`,
      { credentials: 'omit' },
    );
    if (!res.ok) return null; // a board whose slug doesn't resolve - fall through, don't fail
    return selectPostingJd(await res.json(), ref.postingId);
  } catch {
    return null;
  }
}

// Pull `descriptionHtml` out of a posting page's embedded bootstrap payload. Extracting the one
// JSON string (rather than parsing the whole __appData object) keeps this robust to the rest of
// that blob changing shape, which it is entirely free to do.
export function extractDescriptionHtmlFromSource(source: string): string | null {
  const m = /"descriptionHtml"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(source);
  if (!m) return null;
  try {
    const html = JSON.parse(`"${m[1]}"`) as string;
    const text = htmlToPlainText(html);
    return text || null;
  } catch {
    return null;
  }
}

async function fetchAshbyJdFromPage(url: string): Promise<string | null> {
  try {
    // Same-origin (we are on jobs.ashbyhq.com), and the /application route's own HTML carries the
    // payload, so this needs no tab switching and no second window.
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    return extractDescriptionHtmlFromSource(await res.text());
  } catch {
    return null;
  }
}

// DOM fallback. Two bugs were stacked in the old one-liner and both are closed here.
//
// 1. `[class*="job-posting"]` matched the HEADER, never the description: Ashby puts
//    `ashby-job-posting-*` on many elements and querySelector returns the FIRST in DOM order. On
//    Enpal that header's text was "Enpal" (5 chars, truthy) and BECAME the entire "JD"; on Cohere
//    and Mistral it was empty, so the body fallback took over. The intended description element
//    was never selected on any board tested. Taking the LARGEST match instead of the first is what
//    makes a loose selector survivable.
// 2. The `|| document.body.innerText` fallback hid the failure. It is gone: the body is the form
//    on this route, and returning it is how a total failure passed for success. Callers get '' and
//    the chain reports an unreadable JD instead.
export function extractAshbyJdText(): string {
  const candidates = [...document.querySelectorAll('[class*="job-posting"], [class*="description"]')];
  const best = candidates
    .map((el) => el.textContent?.trim() ?? '')
    .reduce((a, b) => (b.length > a.length ? b : a), '');
  return best.slice(0, MAX_JD_CHARS);
}

// The real entry point: try each source in order and return the first that actually reads like a
// job description. Returns JD_UNREADABLE when none does, so the caller can say so plainly rather
// than tailoring a resume to form chrome.
export async function extractAshbyJd(url: string = window.location.href): Promise<string> {
  const ref = parseAshbyPostingRef(url);
  const sources: Array<() => Promise<string | null>> = [
    ...(ref ? [() => fetchAshbyJdFromApi(ref)] : []),
    () => fetchAshbyJdFromPage(url),
    async () => extractAshbyJdText(),
  ];

  for (const source of sources) {
    const text = await source();
    if (looksLikeJobDescription(text)) return text!.slice(0, MAX_JD_CHARS);
  }
  return JD_UNREADABLE;
}

export async function fillAshbyApplication(params: AshbyFillParams): Promise<AutofillResult> {
  const { fullName, email, applicationProfile, resumeBlob, resumeFileName, draftAnswer, onProgress } = params;
  const eeo = params.eeo ?? {};
  let fields_filled = 0;
  let fields_skipped = 0;
  let ai_drafted = 0;
  const skipped_reasons: string[] = [];
  const pendingDrafts: Array<{ el: HTMLTextAreaElement; question: string }> = [];

  if (fullName && (await fillBySelector('input[name="_systemfield_name"]', fullName))) fields_filled++;
  if (email && (await fillBySelector('input[name="_systemfield_email"]', email))) {
    fields_filled++;
  } else if (!email && !document.querySelector<HTMLInputElement>('input[name="_systemfield_email"]')?.value) {
    fields_skipped++;
    skipped_reasons.push('email: not present in stored profile');
  }
  if (applicationProfile.phone && (await fillBySelector('input[name="_systemfield_phone"]', applicationProfile.phone))) {
    fields_filled++;
  }
  if (
    applicationProfile.address_city &&
    (await fillBySelector('input[name="_systemfield_location"]', applicationProfile.address_city))
  ) {
    fields_filled++;
  }

  if (resumeBlob && resumeFileName) {
    if (await fillResumeFile(resumeBlob, resumeFileName)) {
      fields_filled++;
    } else {
      fields_skipped++;
      skipped_reasons.push('resume: no file input found');
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

  // Custom questions (links, work-auth, sponsorship, EEO) get per-posting generated names, so
  // match by label text. Two container shapes exist (live-tested 2026-07-04 on the Notion
  // board): the EEO survey section renders each radio group as `fieldset[class*="_fieldEntry_"]`,
  // but the main form's questions - including Phone, Location, LinkedIn, and sponsorship
  // radios - are `div[class*="_fieldEntry_"]` blocks the fieldset-only selector never saw, which
  // silently skipped every one of them. A div entry can wrap a fieldset entry on some boards, so
  // keep only the innermost match to avoid double-processing a question. Re-queried fresh each
  // iteration since Ashby's React tree can reorder or replace nodes as earlier fields are filled.
  const questionBlocks = Array.from(
    document.querySelectorAll('fieldset[class*="_fieldEntry_"], div[class*="_fieldEntry_"]'),
  ).filter(
    (el) =>
      el.querySelector('input, select, textarea') &&
      !el.querySelector('fieldset[class*="_fieldEntry_"], div[class*="_fieldEntry_"]'),
  );

  for (const block of questionBlocks) {
    if (isNeverFillField(block)) {
      fields_skipped++;
      skipped_reasons.push('never-fill field (SSN/license/background-check consent), left for manual entry');
      continue;
    }

    const label = labelTextFor(block);

    // Link questions, via the one shared classifier (see linkQuestion in generic.ts). Replaces an
    // inline version that let an unset URL fall through to the AI drafter and never looked at a
    // textarea - the two holes behind the Lever prose-in-a-link-field bug. Keeps Ashby's own
    // focus/setNativeValue/blur + waitForStableDom sequence rather than fillField, since these are
    // React-controlled inputs that re-render on input.
    const link = linkQuestion(label, applicationProfile);
    if (link) {
      const linkEl: HTMLInputElement | HTMLTextAreaElement | null =
        block.querySelector<HTMLInputElement>('input[type="text"], input[type="url"]') ??
        (link.asksForLink ? block.querySelector<HTMLTextAreaElement>('textarea') : null);
      // R-030 observation only (see generic.ts): record the labels that fill a URL unconditionally.
      noteLinkFillCandidate(label, link, linkEl);
      if (linkEl && !linkEl.value && !isComboboxControl(linkEl)) {
        if (link.url) {
          await randomDelay();
          linkEl.focus();
          setNativeValue(linkEl, link.url);
          linkEl.blur();
          await waitForStableDom();
          fields_filled++;
        } else {
          fields_skipped++;
          skipped_reasons.push(linkSkipReason(label));
        }
        continue;
      }
    }

    // Phone is a `_systemfield_*` input on some boards (filled above) but a per-posting UUID-named
    // custom field on others (live-tested 2026-07-04: Notion's board), where only the label
    // identifies it. Terminates the block either way, so an unset phone is flagged rather than
    // falling through to the essay drafter. Location used to share this rule; it now has its own
    // block below (R-002), because the inline `/^(location|city)\b/` shape is exactly what left
    // three live required location fields silently blank.
    //
    // The input is resolved BEFORE the label match because `isPhoneLabel` needs the control type
    // to read a bare "Number" label as a phone (R-020) - the label text alone is ambiguous there.
    const input = block.querySelector<HTMLInputElement>('input[type="text"], input[type="tel"]');
    if (isPhoneLabel(label, input) && !blockAlreadyAnswered(block)) {
      // Skip autocomplete comboboxes: a typed value that never selects a suggestion doesn't
      // register as an answer, it just blocks the field.
      if (input && !isComboboxControl(input)) {
        if (applicationProfile.phone) {
          await writeReactText(input, applicationProfile.phone);
          fields_filled++;
        } else {
          fields_skipped++;
          skipped_reasons.push(`${label.slice(0, 40)}: no value in application profile`);
        }
        continue;
      }
    }

    // Location of residence (city/state/country), via the one shared classifier (see
    // locationQuestion in generic.ts). This replaces an inline `/^(location|city)\b/` rule that
    // carried BOTH of the holes behind the link bug (R-008), and lost the same way:
    //   1. It was anchored to the start of the label, so ElevenLabs' "Location* / Country you're
    //      currently residing in" never matched - and it had no country branch to match anyway.
    //   2. Its `textTarget !== undefined` guard collapsed "no city stored" and "not a location
    //      question" into one value, so an unset field fell through to the generic paths and was
    //      left blank with NO reason - the auto-submit gate saw nothing to hold on, and the student
    //      met the empty required field at submit instead of in the card (R-002, 3/12 live forms).
    const loc = locationQuestion(label, applicationProfile);
    if (loc && !blockAlreadyAnswered(block)) {
      if (!loc.value) {
        fields_skipped++;
        skipped_reasons.push(locationSkipReason(loc.field, label, 'no-value'));
        continue;
      }
      // Ashby's location picker is an ASYNC combobox, and classifying the question is only half
      // the fix: the live verdict on the exact form R-002 was logged on (Espa Labs, 2026-07-17)
      // was that the silent blank became a flag, but Location itself stayed EMPTY while the
      // profile held the value. Flagging "couldn't select it in this picker" on a field we can
      // drive is the product politely declining to do the one thing it promised. So the combobox
      // shape gets driven first, with the sequence the QA session proved by hand on five forms:
      // type the FULLER stored query (typing just the city renders no listbox), poll for the
      // async options, click the match with a real element click, and claim the fill only after
      // reading the committed value back. Anything short of a verified commit falls to the flag
      // path below - a flag, never a guess.
      const comboTrigger = comboControlIn(block);
      const comboInput =
        comboTrigger instanceof HTMLInputElement ? comboTrigger : (comboTrigger?.querySelector('input') ?? null);
      if (comboInput && isComboboxControl(comboInput)) {
        const queries = locationComboQueries(loc.field, applicationProfile);
        if (await driveAsyncLocationCombobox(comboInput, queries, block)) {
          await waitForStableDom();
          fields_filled++;
          continue;
        }
        fields_skipped++;
        skipped_reasons.push(locationSkipReason(loc.field, label, 'no-option'));
        continue;
      }
      // Non-combobox shapes: native select / radios via the option matcher, then a plain input.
      const desired: Desired = { mode: 'value', value: loc.value };
      if (await answerChoiceBlock(block, desired)) {
        fields_filled++;
        continue;
      }
      const locEl = block.querySelector<HTMLInputElement>('input[type="text"], input[type="tel"]');
      if (locEl && !isComboboxControl(locEl)) {
        await writeReactText(locEl, loc.value);
        fields_filled++;
        continue;
      }
      fields_skipped++;
      skipped_reasons.push(locationSkipReason(loc.field, label, 'no-option'));
      continue;
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
    const isEeo = /gender|race|ethnicit|veteran|disab|current age|sexual orientation|communities|identify with/i.test(label);
    if (isEeo) {
      // Real answer when the student stored one (eeo prefs), else decline - and for any diversity
      // question we have no specific rule for (age buckets, "which communities", orientation), the
      // safe default is still decline rather than blank, so a required survey field doesn't block
      // submission. Works across native select, native radios, checkbox "select all" groups, react
      // -select comboboxes, and Ashby's <button> option pills.
      const desired = desiredAnswer(label, applicationProfile, eeo) ?? { mode: 'decline' };
      if (await answerChoiceBlock(block, desired)) {
        fields_filled++;
      } else {
        fields_skipped++;
        skipped_reasons.push('EEO field: no matching option found, left blank');
      }
      continue;
    }

    // Language proficiency, via the one shared classifier (see languageQuestion in generic.ts).
    // Answered ONLY from the student's declared list (declared-list authority, R-015's lesson).
    // Placed AFTER the work-eligibility and EEO branches (refusal precedence, locationQuestion's
    // ordering doctrine) - languageAnswerPlan re-checks those refusals internally, so a
    // regression in either ordering alone cannot route a legal question to a language answer.
    // ALWAYS terminates the block: fill (a not-declared No or lowest level also pushes a review
    // reason that HOLDS auto-submit) or flag, never silence, and never the drafter - a drafted
    // paragraph claiming comfort in an undeclared language is a fabricated claim in her voice.
    const langPlan = languageAnswerPlan(label, applicationProfile);
    if (langPlan && !blockAlreadyAnswered(block)) {
      if (langPlan.kind === 'skip') {
        fields_skipped++;
        skipped_reasons.push(langPlan.reason);
        continue;
      }
      if (await answerChoiceBlock(block, langPlan.desired)) {
        fields_filled++;
        if (langPlan.reviewReason) {
          const reviewEl = block.querySelector<HTMLElement>('input, select, textarea');
          if (reviewEl) markForReview(reviewEl, 'Language answer: review before submitting');
          skipped_reasons.push(langPlan.reviewReason);
        }
      } else {
        fields_skipped++;
        skipped_reasons.push(languageSkipReason(label, 'no honest option to select'));
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
          // Ashby's own React-safe write (focus / native setter / blur / let the re-render settle),
          // not shared/dom's fillField: these are controlled inputs that re-render on input.
          await randomDelay();
          gradeEl.focus();
          setNativeValue(gradeEl, grade.value);
          gradeEl.blur();
          await waitForStableDom();
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

    // Salary (R-031 + R-011): the posting's own stated range first (the label, then the posting
    // API's structured compensation payload), median only; then the stored answer behind the
    // currency gate. Like the grade branch, this ALWAYS terminates the block - a salary question
    // must fill or flag, never fall through to the drafter or a silent blank. Before this branch
    // existed, salary rode the generic known-answer path below: a bare stored figure was typed
    // into TEXT salary fields with no currency check (R-031's exact failure), and a NUMERIC
    // salary field was invisible to the known path's text/url/tel selector, so it fell to a
    // "no matching control" skip even when a value was stored (the Proxima Fusion parking).
    if (classifyField(label.toLowerCase()) === 'desired_salary' && !blockAlreadyAnsweredForGrade(block)) {
      const numberEl = block.querySelector<HTMLInputElement>('input[type="number"]');
      const freeEl = block.querySelector<HTMLInputElement | HTMLTextAreaElement>('input[type="text"], textarea');
      const numeric = !!numberEl || /^(numeric|decimal)$/i.test(freeEl?.getAttribute('inputmode') ?? '');
      const salary = resolveSalary(
        { label, field: numeric ? 'numeric' : 'freetext', posting: params.postingCompensation ?? null },
        storedSalaryOf(applicationProfile),
      );
      if (salary.action === 'flag') {
        fields_skipped++;
        skipped_reasons.push(salary.reason);
        continue;
      }
      // Choice-rendered salary (a dropdown of bands): match the resolved answer against the
      // options; matchOption never guesses, so an unmatched band set falls to the flag below.
      if (await answerChoiceBlock(block, { mode: 'value', value: salary.value })) {
        fields_filled++;
        continue;
      }
      const salaryEl = numberEl ?? freeEl;
      if (salaryEl && !salaryEl.value && !isComboboxControl(salaryEl)) {
        await writeReactText(salaryEl, salary.value);
        fields_filled++;
        continue;
      }
      fields_skipped++;
      skipped_reasons.push(salarySkipReason(label, 'no control this answer fits'));
      continue;
    }

    // Other known-answer questions (age of majority, citizenship, availability, referral source,
    // DOB) resolved from the profile, across select / radio / combobox / free text.
    const known = desiredAnswer(label, applicationProfile, eeo);
    if (known) {
      if (await answerChoiceBlock(block, known)) {
        fields_filled++;
        continue;
      }
      if (known.mode === 'value') {
        // type="date" is included so a native picker is reachable at all - it was invisible to
        // this selector before, and an unmatched block is reported as "no matching control".
        const textEl = block.querySelector<HTMLInputElement>(
          'input[type="text"], input[type="url"], input[type="tel"], input[type="date"]',
        );
        const isCombo = textEl ? textEl.getAttribute('role') === 'combobox' || !!textEl.getAttribute('aria-autocomplete') : false;
        if (textEl && !textEl.value && !isCombo) {
          // Enpal's start-date picker is where R-014 was found: it parses MM/DD/YYYY, so a Dubai
          // -shaped "18/07/2026" left React's state empty while the box still showed the text, and
          // the submit bounced on a field that visibly had content. Dates go through the verified
          // formatter; everything else keeps the plain write.
          if (isDateControl(textEl, label)) {
            if (await fillDateField(textEl, known.value)) {
              await waitForStableDom();
              fields_filled++;
            } else {
              fields_skipped++;
              skipped_reasons.push(dateSkipReason(known.value, label.slice(0, 40)));
            }
            continue;
          }
          await randomDelay();
          textEl.focus();
          setNativeValue(textEl, known.value);
          textEl.blur();
          await waitForStableDom();
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
          await randomDelay();
          el.focus();
          setNativeValue(el, drafted);
          el.blur();
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

  return { ats_name: 'ashby', fields_filled, fields_skipped, ai_drafted, skipped_reasons };
}
