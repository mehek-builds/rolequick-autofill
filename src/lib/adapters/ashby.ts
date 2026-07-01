import type { ApplicationProfile, AutofillResult, Profile } from '../types';

// Ashby field-mapping adapter (PRD-v2-resume-autofill.md Section 7, build-order step 3).
// Ashby's built-in identity fields use a stable `_systemfield_*` name-attribute convention
// across every board (name, email, phone, location); everything else - links, work-auth,
// EEO, custom screening questions - gets a per-posting generated name/id, so those are
// matched by label text, same defensive pattern as Lever and Greenhouse.
//
// The one Ashby-specific risk (Section 7's table): the form is React-rendered and can
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

function labelTextFor(el: Element): string {
  const container = el.closest('[class*="_container_"], [class*="field"], li') ?? el.parentElement;
  return (container?.textContent ?? '').trim().toLowerCase();
}

function isNeverFillField(el: Element): boolean {
  const label = labelTextFor(el);
  return NEVER_FILL_LABEL_PATTERNS.some((re) => re.test(label));
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
  const input = document.querySelector<HTMLInputElement>(
    'input[type="file"][name*="resume" i], input[type="file"]',
  );
  if (!input) return false;
  await randomDelay();
  const file = new File([blob], fileName, {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
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
  return window.location.hostname.includes('ashbyhq.com') && window.location.pathname.includes('/apply');
}

export function extractAshbyJdText(): string {
  const desc = document.querySelector('[class*="job-posting"], [class*="description"]');
  return (desc?.textContent ?? document.body.innerText).trim().slice(0, 12000);
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

  // Custom questions (links, work-auth, sponsorship, EEO) get per-posting generated names,
  // so match by label text - re-queried fresh each iteration since Ashby's React tree can
  // reorder or replace nodes as earlier fields are filled.
  const questionBlocks = Array.from(document.querySelectorAll('[class*="_container_"], li')).filter(
    (el) => el.querySelector('input, select, textarea') && el.textContent,
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
      const radio = block.querySelector<HTMLInputElement>(`input[type="radio"][value="${wantYes ? 'Yes' : 'No'}" i]`);
      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        await waitForStableDom();
        fields_filled++;
        continue;
      }
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
    }

    const textInput = block.querySelector('input[type="text"], textarea');
    if (textInput && !(textInput as HTMLInputElement).value) {
      fields_skipped++;
      skipped_reasons.push(`open-ended question left blank: "${label.slice(0, 60)}"`);
    }
  }

  return { ats_name: 'ashby', fields_filled, fields_skipped, skipped_reasons };
}
