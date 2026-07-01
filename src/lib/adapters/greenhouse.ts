import type { ApplicationProfile, AutofillResult, Profile } from '../types';

// Greenhouse field-mapping adapter (PRD-v2-resume-autofill.md Section 7, build-order step 2).
// Greenhouse's core identity fields use a stable `job_application[...]` naming convention across
// every board, but custom questions (links, work-auth, EEO) get dynamic per-posting IDs, so those
// are matched by label text, same defensive approach as the Lever adapter.
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
  const container = el.closest('.field, #custom_fields > div, li') ?? el.parentElement;
  return (container?.textContent ?? '').trim().toLowerCase();
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

// `<input type="file">` can't be set directly by script; construct a File/DataTransfer and
// dispatch it (PRD-v2 Section 9). Greenhouse's dropzone UI sits on top of a real file input in
// same-origin embeds, which this works against; it does not work if the dropzone itself is the
// only interactive element with no underlying <input type="file"> in this frame's DOM (rare, but
// flagged rather than silently failing - the caller reports it as a skipped field).
async function fillResumeFile(input: HTMLInputElement, blob: Blob, fileName: string): Promise<void> {
  await randomDelay();
  const file = new File([blob], fileName, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
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
  const hasNameField = !!document.querySelector('input[name="job_application[first_name]"]');
  const hasResumeUpload = !!document.querySelector('input[type="file"], [data-source="resume"], #resume_dropzone');
  return hasNameField || hasResumeUpload;
}

export function extractGreenhouseJdText(): string {
  const desc = document.querySelector('#content, .job__description, [data-qa="job-description"]');
  return (desc?.textContent ?? document.body.innerText).trim().slice(0, 12000);
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

  const firstEl = document.querySelector<HTMLInputElement>('input[name="job_application[first_name]"]');
  const lastEl = document.querySelector<HTMLInputElement>('input[name="job_application[last_name]"]');
  const emailEl = document.querySelector<HTMLInputElement>('input[name="job_application[email]"]');
  const phoneEl = document.querySelector<HTMLInputElement>('input[name="job_application[phone]"]');
  const resumeEl = document.querySelector<HTMLInputElement>(
    'input[type="file"][name="job_application[resume]"], #resume_dropzone input[type="file"], input[type="file"]#resume',
  );

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
  const questionBlocks = document.querySelectorAll('#custom_fields .field, #custom_fields > div, .eeoc-container .field');
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
      if (select && declineOption) {
        select.value = declineOption.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        fields_filled++;
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
