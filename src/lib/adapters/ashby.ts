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
} from './shared/dom';
// Reuse the generic adapter's pure answer-resolution engine so every adapter maps a question to
// the same answer and picks the same option. Pure (no DOM), covered by the adapter answer tests.
import { dateSkipReason, desiredAnswer, fillDateField, linkQuestion, linkSkipReason, matchOption, WORK_ELIGIBILITY_QUESTION, workEligibilitySkipReason, type Desired } from './generic';
import { isDateControl } from './shared/dates';

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
  const legend = entry?.querySelector('legend');
  if (legend) return legend.textContent?.trim().toLowerCase() ?? '';
  // div-based entries (text questions) carry a real <label>; fall back to full text only when
  // neither a legend nor a label exists.
  const label = entry?.querySelector('label');
  if (label) return label.textContent?.trim().toLowerCase() ?? '';
  const container = entry ?? el.closest('[class*="_container_"], li') ?? el.parentElement;
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
}

export function isAshbyApplicationPage(): boolean {
  // Live-tested 2026-07-02 (jobs.ashbyhq.com/notion): the real apply-flow path is
  // "/application", not "/apply" - "/apply" alone never matched anything on this template and
  // the fill card never appeared. Both are checked in case older/other boards use "/apply".
  const path = window.location.pathname;
  return window.location.hostname.includes('ashbyhq.com') && (path.includes('/apply') || path.includes('/application'));
}

export function extractAshbyJdText(): string {
  const desc = document.querySelector('[class*="job-posting"], [class*="description"]');
  const descText = desc?.textContent?.trim();
  return (descText || document.body.innerText).trim().slice(0, 12000);
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

    // Phone/location are `_systemfield_*` inputs on some boards (filled above) but per-posting
    // UUID-named custom fields on others (live-tested 2026-07-04: Notion's board), where only
    // the label identifies them.
    //
    // The input is resolved BEFORE the label match because `isPhoneLabel` needs the control type
    // to read a bare "Number" label as a phone (R-020) - the label text alone is ambiguous there.
    const input = block.querySelector<HTMLInputElement>('input[type="text"], input[type="tel"]');
    const textTarget =
      isPhoneLabel(label, input) ? applicationProfile.phone :
      /^(location|city)\b/.test(label) ? applicationProfile.address_city :
      undefined;
    if (textTarget !== undefined) {
      // Skip autocomplete comboboxes (Location on most boards): a typed value that never
      // selects a suggestion doesn't register as an answer, it just blocks the field.
      const isCombobox = input?.getAttribute('role') === 'combobox' || !!input?.getAttribute('aria-autocomplete');
      if (input && !input.value && !isCombobox) {
        if (textTarget) {
          await randomDelay();
          input.focus();
          setNativeValue(input, textTarget);
          input.blur();
          await waitForStableDom();
          fields_filled++;
        } else {
          fields_skipped++;
          skipped_reasons.push(`${label.slice(0, 40)}: no value in application profile`);
        }
        continue;
      }
      if (input && !input.value && isCombobox) {
        // Ashby's location field is a react-select combobox: drive it through the shared helpers
        // rather than skipping it, since a typed value that never selects a suggestion doesn't
        // register as an answer.
        if (textTarget && (await fillCombobox(input, { mode: 'value', value: textTarget }))) {
          fields_filled++;
        } else {
          fields_skipped++;
          skipped_reasons.push(`${label.slice(0, 40)}: autocomplete field, left for manual selection`);
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

    // Other known-answer questions (age of majority, citizenship, availability, referral source,
    // salary, DOB) resolved from the profile, across select / radio / combobox / free text.
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
        pendingEssays--;
        onProgress?.({ fields_filled, fields_skipped, ai_drafted, pendingEssays });
      }),
    );
  }

  if (ai_drafted > 0) {
    skipped_reasons.unshift(`${ai_drafted} open-ended answer${ai_drafted === 1 ? '' : 's'} AI-drafted, review before submitting`);
  }

  return { ats_name: 'ashby', fields_filled, fields_skipped, ai_drafted, skipped_reasons };
}
