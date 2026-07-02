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
// The biggest thing live testing caught: yes/no questions (work-authorization, sponsorship),
// the EEO "decline to answer" options, and the city field are NOT plain inputs or native
// <select> elements - they're react-select comboboxes (role="combobox", aria-autocomplete="list",
// aria-controls="react-select-<id>-listbox" once open). Setting .value directly does nothing
// real: react-select clears it back to empty on blur since no option was actually selected.
//
// selectReactSelectOption() below opens the menu and clicks the matching [role="option"] element
// - but verified live (2026-07-01), that open step ONLY responds to a genuinely trusted click
// event. Every synthetic variant tried (dispatchEvent(MouseEvent) on the input, on the
// `.select__control` wrapper, focus(), a synthetic ArrowDown keydown) left aria-expanded="false";
// a real click via Chrome's input-injection layer opened it instantly. Content scripts can only
// ever dispatch untrusted events (isTrusted is always false for anything script-originated - this
// isn't fixable with a different event type or target), so THIS WIDGET CLASS CANNOT BE FILLED by
// any Manifest V3 content script, Volley's or anyone else's. selectReactSelectOption() is kept
// because it's harmless when it fails (falls through to skip+flag, never fakes success, never
// partially fills), and some other Greenhouse deployments may render a plain native <select> or a
// less defended combobox that DOES respond to synthetic events - but on this template, expect
// every combobox-shaped custom question to end up in `skipped_reasons` for the student to fill
// by hand. Core identity fields (name/email/phone/resume) and genuinely-plain-text custom
// questions (LinkedIn/GitHub/portfolio links, open-ended text) are real inputs, not comboboxes,
// and fill normally - confirmed working live.
//
// Cross-origin iframe (Section 12.3's spike): some companies embed their Greenhouse board inside
// an iframe on their own domain (e.g. company.com/careers embedding boards.greenhouse.io/company).
// A Chrome content script's `matches` patterns are evaluated per-frame, not per-tab, so as long as
// the manifest also sets `all_frames: true`, a content script matching `*.greenhouse.io/*` injects
// directly into that iframe (it runs with the iframe's own origin, not the parent page's) - no
// special cross-frame messaging needed. This only breaks for the rarer case of a fully custom
// embed that proxies the form through the parent's own origin instead of an iframe pointing at a
// greenhouse.io URL; that case still isn't covered and is flagged below.

const NEVER_FILL_LABEL_PATTERNS = [/social security/i, /ssn\b/i, /driver'?s?\s*licen[sc]e/i, /background check consent/i];

function randomDelay(minMs = 120, maxMs = 380): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

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

async function fillField(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await randomDelay();
  el.focus();
  setNativeValue(el, value);
  el.blur();
}

// aria-controls only exists once the menu is open (react-select adds it dynamically), so it
// can't be used to detect a closed combobox - aria-autocomplete is present in both states.
function isReactSelectCombobox(el: Element): el is HTMLInputElement {
  return el.getAttribute('role') === 'combobox' && el.getAttribute('aria-autocomplete') === 'list';
}

async function waitFor(predicate: () => boolean, timeoutMs = 800, stepMs = 60): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

// Drives a react-select combobox by opening its menu and clicking a real option element - the
// only way that actually registers a selection. `matchText` is matched case-insensitively; exact
// match wins, otherwise the first option whose text contains it. Returns false (never guesses,
// never fakes success) whenever the menu never opens or no matching option appears - which, per
// the file header note, is the expected outcome on this Greenhouse template's react-select
// widgets specifically, since their menu-open handler only responds to a trusted click.
async function selectReactSelectOption(input: HTMLInputElement, matchText: string): Promise<boolean> {
  await randomDelay();
  const listboxId = input.getAttribute('aria-controls')!;
  input.focus();
  input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await waitFor(() => input.getAttribute('aria-expanded') === 'true');

  const findMatch = () => {
    const listbox = document.getElementById(listboxId);
    if (!listbox) return null;
    const options = [...listbox.querySelectorAll<HTMLElement>(`[id^="${listboxId}-option-"]`)];
    return (
      options.find((o) => o.textContent?.trim().toLowerCase() === matchText.toLowerCase()) ??
      options.find((o) => o.textContent?.toLowerCase().includes(matchText.toLowerCase())) ??
      null
    );
  };

  let match = findMatch();
  if (!match) {
    // Large/searchable option sets (e.g. city, university) need typing to filter down first.
    setNativeValue(input, matchText);
    await waitFor(() => findMatch() !== null, 1200);
    match = findMatch();
  }
  if (!match) {
    input.blur();
    return false;
  }

  match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  match.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  match.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await randomDelay();
  return true;
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

function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

export async function fillGreenhouseApplication(params: GreenhouseFillParams): Promise<AutofillResult> {
  const { fullName, email, profile, applicationProfile, resumeBlob, resumeFileName } = params;
  let fields_filled = 0;
  let fields_skipped = 0;
  const skipped_reasons: string[] = [];

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
    if (isReactSelectCombobox(cityEl)) {
      if (await selectReactSelectOption(cityEl, applicationProfile.address_city)) {
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

  // Custom fields (links, work-auth, sponsorship, EEO) get dynamic per-posting IDs, so match by
  // the surrounding label text instead of a selector - same approach as the Lever adapter.
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
      // Never guess or default EEO fields (PRD-v2 non-goals). Only select "Decline to
      // Self-Identify" where the option exists; otherwise leave untouched.
      const select = block.querySelector<HTMLSelectElement>('select');
      const declineOption = select
        ? [...select.options].find((o) => /decline/i.test(o.text))
        : undefined;
      const comboboxInput = block.querySelector<HTMLInputElement>('input[role="combobox"]');
      if (select && declineOption) {
        select.value = declineOption.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        fields_filled++;
      } else if (comboboxInput && isReactSelectCombobox(comboboxInput)) {
        if (await selectReactSelectOption(comboboxInput, 'Decline')) {
          fields_filled++;
        } else {
          fields_skipped++;
          skipped_reasons.push('EEO field: no decline-to-answer option found, left blank');
        }
      } else {
        const declineRadio = block.querySelector<HTMLInputElement>('input[type="radio"][value*="Decline" i]');
        if (declineRadio) {
          declineRadio.checked = true;
          declineRadio.dispatchEvent(new Event('change', { bubbles: true }));
          fields_filled++;
        } else {
          fields_skipped++;
          skipped_reasons.push('EEO field: no decline-to-answer option found, left blank');
        }
      }
      continue;
    }

    const isAuthQuestion = /authoriz(ed|ation) to work/i.test(label);
    const isSponsorQuestion = /sponsorship/i.test(label);
    if ((isAuthQuestion || isSponsorQuestion) && (applicationProfile.work_authorized !== undefined || applicationProfile.needs_sponsorship !== undefined)) {
      const wantYes = isAuthQuestion ? applicationProfile.work_authorized : applicationProfile.needs_sponsorship;
      const select = block.querySelector<HTMLSelectElement>('select');
      const radio = block.querySelector<HTMLInputElement>(`input[type="radio"][value="${wantYes ? 'Yes' : 'No'}" i]`);
      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        fields_filled++;
        continue;
      }
      if (select) {
        const opt = [...select.options].find((o) => new RegExp(wantYes ? '^yes' : '^no', 'i').test(o.text.trim()));
        if (opt) {
          select.value = opt.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          fields_filled++;
          continue;
        }
      }
      // Verified live (2026-07-01, Gemini's Greenhouse posting): these yes/no questions render
      // as a react-select combobox far more often than a plain input - a bare setNativeValue
      // gets silently cleared by react-select on blur since no option was actually selected.
      const textYesNo = block.querySelector<HTMLInputElement>('input[type="text"]');
      if (textYesNo && !textYesNo.value) {
        if (isReactSelectCombobox(textYesNo)) {
          if (await selectReactSelectOption(textYesNo, wantYes ? 'Yes' : 'No')) {
            fields_filled++;
          } else {
            fields_skipped++;
            skipped_reasons.push(`${label.slice(0, 40)}: no matching Yes/No option found, left blank`);
          }
        } else {
          await fillField(textYesNo, wantYes ? 'Yes' : 'No');
          fields_filled++;
        }
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

  return { ats_name: 'greenhouse', fields_filled, fields_skipped, skipped_reasons };
}
