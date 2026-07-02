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

const NEVER_FILL_LABEL_PATTERNS = [/social security/i, /ssn\b/i, /driver'?s?\s*licen[sc]e/i, /background check consent/i];

function randomDelay(minMs = 120, maxMs = 380): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// Verified live: `fieldset[class*="_fieldEntry_"]` is the per-question container for BOTH radio
// groups and text inputs. A generic `[class*="_container_"]` ancestor is too broad - it can wrap
// several unrelated questions together, mixing their radios in one lookup. Prefer <legend> (used
// on radio-group fieldsets) over full textContent, which would otherwise include every option's
// label text glued onto the question text.
function labelTextFor(el: Element): string {
  const fieldset = el.closest('fieldset[class*="_fieldEntry_"]');
  const legend = fieldset?.querySelector('legend');
  if (legend) return legend.textContent?.trim().toLowerCase() ?? '';
  const container = fieldset ?? el.closest('[class*="_container_"], li') ?? el.parentElement;
  return (container?.textContent ?? '').trim().toLowerCase();
}

function isNeverFillField(el: Element): boolean {
  const label = labelTextFor(el);
  return NEVER_FILL_LABEL_PATTERNS.some((re) => re.test(label));
}

// Ashby radios carry no meaningful `value` (always "on"); the real option text lives in
// `label[for=radio.id]`. Returns each radio paired with its label text, lowercased.
function radioOptionsIn(block: Element): Array<{ radio: HTMLInputElement; text: string }> {
  return [...block.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((radio) => ({
    radio,
    text: (document.querySelector(`label[for="${radio.id}"]`)?.textContent ?? '').trim().toLowerCase(),
  }));
}

async function checkRadio(radio: HTMLInputElement): Promise<void> {
  await randomDelay();
  radio.checked = true;
  radio.dispatchEvent(new Event('input', { bubbles: true }));
  radio.dispatchEvent(new Event('change', { bubbles: true }));
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
  const { fullName, email, applicationProfile, resumeBlob, resumeFileName } = params;
  let fields_filled = 0;
  let fields_skipped = 0;
  const skipped_reasons: string[] = [];

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
  // match by label text - verified live that `fieldset[class*="_fieldEntry_"]` is the correct
  // one-question-per-block container (a generic `[class*="_container_"]` ancestor mixes multiple
  // questions' radios together). Re-queried fresh each iteration since Ashby's React tree can
  // reorder or replace nodes as earlier fields are filled.
  const questionBlocks = Array.from(document.querySelectorAll('fieldset[class*="_fieldEntry_"]')).filter(
    (el) => el.querySelector('input, select, textarea'),
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
          await randomDelay();
          input.focus();
          setNativeValue(input, linkTarget);
          input.blur();
          await waitForStableDom();
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
      const select = block.querySelector<HTMLSelectElement>('select');
      const declineOption = select ? [...select.options].find((o) => /decline/i.test(o.text)) : undefined;
      if (select && declineOption) {
        select.value = declineOption.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await waitForStableDom();
        fields_filled++;
        continue;
      }
      // Native radios: value is always "on" on Ashby, so match by the associated <label> text.
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
          await waitForStableDom();
          fields_filled++;
          continue;
        }
      }
      // Not every question here is a clean Yes/No (e.g. a sponsorship-type question rendered as
      // J1/F1/None/Other) - applicationProfile only has a boolean, so only fill when exactly one
      // option's label unambiguously means yes/no/none; otherwise skip rather than guess a
      // specific visa type or similar.
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

    const textInput = block.querySelector('input[type="text"], textarea');
    if (textInput && !(textInput as HTMLInputElement).value) {
      fields_skipped++;
      skipped_reasons.push(`open-ended question left blank: "${label.slice(0, 60)}"`);
    }
  }

  return { ats_name: 'ashby', fields_filled, fields_skipped, skipped_reasons };
}
