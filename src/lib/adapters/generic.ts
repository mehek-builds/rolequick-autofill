import type { ApplicationProfile, AutofillResult, Profile } from '../types';
import { commitChoice as checkChoice } from './shared/dom';

// Generic adapter for companies that build their OWN application form on their own domain
// against an ATS's API (live-tested targets 2026-07-04: vercel.com/careers - Greenhouse API
// behind a native form; lifeatspotify.com - Lever API behind a native form). There are no
// stable per-ATS selectors here, so every field is matched by the text a human would read:
// its <label>, aria-label, placeholder, name, and id, in that order of trust.
//
// This adapter is never auto-injected. The content script only reaches an arbitrary company
// domain when the student clicks "Fill the form on this page" in the popup (activeTab +
// chrome.scripting), so running here is itself evidence of an explicit user request.
//
// Coverage (2026-07-04, "answer every question"): text/email/tel/url inputs, the resume file
// input, <select> dropdowns, radio groups, factual-eligibility checkboxes, DOB/salary, EEO
// demographics (real answer when the student provided one in onboarding, else "decline to
// self-identify"), and open-ended textareas (AI-drafted via the optional draftAnswer hook,
// then visibly flagged for review). What it still never touches: SSN / driver's license,
// legal-agreement & accuracy-certification checkboxes (the student's own sign-off), and any
// question it can't answer confidently - all counted and reported, never guessed.

// Truly off-limits regardless of what the form asks.
const NEVER_FILL_PATTERNS = [/social security/i, /\bssn\b/i, /driver'?s?\s*licen[sc]e/i];

function randomDelay(minMs = 90, maxMs = 260): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
    HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function visibleLabelFor(el: HTMLInputElement): HTMLElement | null {
  return (
    (el.labels && el.labels[0]) ??
    (el.id ? document.querySelector<HTMLElement>(`label[for="${CSS.escape(el.id)}"]`) : null) ??
    el.closest('label')
  );
}

// Native radios/checkboxes are routinely hidden (display:none / sr-only / 1px absolute)
// behind a styled <label> that is the control the student actually sees, so the input's own
// box says nothing about whether the question is on screen. Filtering groups by isVisible(el)
// dropped those groups before matching even ran, with no skipped_reasons entry - the exact
// silent non-fill reported for profile-driven radios / EEO-decline.
function isInteractableChoice(el: HTMLInputElement): boolean {
  if (isVisible(el)) return true;
  const label = visibleLabelFor(el);
  return !!label && isVisible(label);
}

// checkChoice is the shared commitChoice (imported above) - the click-first radio/checkbox
// setter, kept in one place so this fix stays in sync across every adapter.

// Strip zero-width and non-breaking characters, then collapse whitespace. Live-tested
// 2026-07-04 on vercel.com: every radio option is prefixed with U+200B, which `\s` does NOT
// match, so `/^\s*yes/` failed on "​Yes" and clean Yes/No answers were skipped. Every label
// and option string is run through this before any matching.
function clean(s: string): string {
  return (s ?? '').replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Everything a human could read as a control's identity, lowercased. Label text is the
// strongest signal, so it leads; name/id are framework-generated noise, so they trail.
function controlIdentity(el: Element): string {
  const parts: string[] = [];
  const withLabels = el as HTMLInputElement;
  const label =
    (withLabels.labels && withLabels.labels[0]?.textContent) ||
    (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : '') ||
    '';
  parts.push(label ?? '');
  parts.push(el.getAttribute('aria-label') ?? '');
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    parts.push(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '));
  }
  parts.push(el.getAttribute('placeholder') ?? '');
  parts.push(el.getAttribute('name') ?? '');
  parts.push(el.id ?? '');
  return clean(parts.join(' ')).toLowerCase();
}

// The question a single control (usually a <select>) is asking. Prefer a real container
// label over the control's own attributes.
function questionLabel(el: Element): string {
  const fieldset = el.closest('fieldset');
  const legend = fieldset?.querySelector('legend')?.textContent?.trim();
  if (legend) return legend.toLowerCase();
  const group = el.closest('[role="group"], [role="radiogroup"]');
  const groupLabel = group?.getAttribute('aria-label');
  if (groupLabel) return groupLabel.toLowerCase();
  const own = controlIdentity(el);
  if (own) return own;
  const block = el.closest('div, section, li');
  return (block?.querySelector('label, legend, .question, h3, h4')?.textContent ?? '').toLowerCase().trim();
}

// The question a RADIO GROUP (or checkbox "mark all that apply" group) is asking. Live-tested
// 2026-07-04 on vercel.com (Greenhouse behind a native form): the question sits in an ancestor
// ABOVE the options, not in a <legend>, so reading any single option's own label returns one
// option's text, never the question. Instead: find the topmost ancestor that still contains
// exactly this group's options (never merging a neighbouring question), then subtract every
// option's label from its text - what remains is the question stem. Works for both input
// types since the climb selector is derived from the group's own `type`.
function groupQuestionText(group: HTMLInputElement[], optionTexts: string[]): string {
  const legend = group[0].closest('fieldset')?.querySelector('legend')?.textContent?.trim();
  if (legend) return legend.toLowerCase();
  const ariaGroup = group[0].closest('[role="group"], [role="radiogroup"]')?.getAttribute('aria-label');
  if (ariaGroup) return ariaGroup.toLowerCase();

  const selector = `input[type="${group[0].type}"]`;
  let anc: HTMLElement | null = group[0].parentElement;
  while (anc && group.some((r) => !anc!.contains(r))) anc = anc.parentElement; // smallest ancestor of all
  let top = anc;
  while (
    top?.parentElement &&
    top.parentElement.querySelectorAll(selector).length === group.length
  ) {
    top = top.parentElement; // climb while still exactly this group
  }
  let text = clean(top?.textContent ?? '');
  for (const ot of optionTexts) {
    const co = clean(ot);
    if (co && co.length > 1) text = text.split(co).join(' ');
  }
  text = clean(text).toLowerCase();
  return text || controlIdentity(group[0]);
}

function isAutocompleteWidget(el: HTMLElement): boolean {
  return el.getAttribute('role') === 'combobox' || !!el.getAttribute('aria-autocomplete');
}

function candidateInputs(): Array<HTMLInputElement | HTMLTextAreaElement> {
  return [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea',
  )].filter((el) => !el.closest('[id*="volley"]') && !el.disabled && !el.readOnly && isVisible(el));
}

export function isLikelyApplicationForm(): boolean {
  const inputs = candidateInputs();
  const hasName = inputs.some((el) => /\bname\b/.test(controlIdentity(el)));
  const hasEmail = inputs.some(
    (el) => (el as HTMLInputElement).type === 'email' || /e-?mail/.test(controlIdentity(el)),
  );
  const fileInputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
  const hasResumeUpload = fileInputs.some((el) => {
    const ctx = `${controlIdentity(el)} ${el.closest('div,section,fieldset')?.textContent?.slice(0, 200) ?? ''}`.toLowerCase();
    return /resume|\bcv\b|curriculum/.test(ctx);
  });
  return hasResumeUpload || (hasName && hasEmail);
}

export function extractGenericJdText(): string {
  return document.body.innerText.trim().slice(0, 12000);
}

export function getGenericJobDetails(): { title: string; company: string } {
  const meta = (name: string) =>
    document.querySelector<HTMLMetaElement>(`meta[property="${name}"], meta[name="${name}"]`)?.content?.trim();
  let title = meta('og:title') || document.title || '';
  const site = meta('og:site_name');
  if (site && title.endsWith(site)) title = title.slice(0, title.length - site.length).replace(/[\s|–-]+$/, '');
  else if (title.includes(' | ')) title = title.split(' | ')[0].trim();
  const host = location.hostname.replace(/^www\./, '');
  const company = site || host.split('.')[0];
  return { title: title || 'this role', company: company || host };
}

// ─── Answer resolution ──────────────────────────────────────────────────────
// One question label -> one desired answer, or null (leave blank, report). Kept separate
// from the DOM so it stays pure and testable. 'yes'/'no' are matched against option text by
// the option matcher; 'decline' matches an opt-out option; 'value' substring-matches.

export type Desired =
  | { mode: 'value'; value: string }
  | { mode: 'yes' }
  | { mode: 'no' }
  | { mode: 'decline' }
  | null;

export function eeoAnswer(pref: string | undefined): Desired {
  return pref && pref.trim() ? { mode: 'value', value: pref.trim() } : { mode: 'decline' };
}

export function desiredAnswer(label: string, ap: ApplicationProfile, eeo: Record<string, string>): Desired {
  const l = label;
  if (NEVER_FILL_PATTERNS.some((re) => re.test(l))) return null;

  // Eligibility yes/no.
  if (/authoriz(ed|ation)\s+to\s+work|legally\s+authorized|right\s+to\s+work|work\s+authoriz/.test(l) && ap.work_authorized !== undefined)
    return ap.work_authorized ? { mode: 'yes' } : { mode: 'no' };
  if (/sponsor/.test(l) && ap.needs_sponsorship !== undefined)
    return ap.needs_sponsorship ? { mode: 'yes' } : { mode: 'no' };
  if (/(at least|over|older than)\s*(18|eighteen)|age of majority|18 years/.test(l))
    return { mode: 'yes' };

  // EEO / demographics: real answer if the student provided one, else decline.
  // \bgender\b (not /gender/) so "do you identify as transgender?" - a distinct yes/no
  // self-ID question we have no data for - doesn't get pulled into the gender-value rule.
  if (/\bgender\b|what is your sex\b/.test(l)) return eeoAnswer(eeo.gender);
  if (/race|ethnic/.test(l)) return eeoAnswer(eeo.race);
  if (/hispanic|latino/.test(l)) return { mode: 'decline' };
  if (/veteran|military|protected\s+veteran/.test(l)) return eeoAnswer(eeo.veteran);
  if (/disab/.test(l)) return eeoAnswer(eeo.disability);

  // Factual profile values.
  if (/citizenship|country of citizenship|which country|country of residence/.test(l) && ap.citizenship)
    return { mode: 'value', value: ap.citizenship };
  if (/how did you hear|referral source|hear about (this|us|the)|source of/.test(l) && ap.referral_source_default)
    return { mode: 'value', value: ap.referral_source_default };
  if (/salary|compensation|desired pay|expected pay|pay expectation/.test(l) && ap.desired_salary)
    return { mode: 'value', value: ap.desired_salary };
  if (/date of birth|birth\s*date|\bdob\b/.test(l) && ap.date_of_birth)
    return { mode: 'value', value: ap.date_of_birth };
  if (/availab|start date|when can you start|earliest start/.test(l) && ap.availability_date)
    return { mode: 'value', value: ap.availability_date };

  return null;
}

const DECLINE_RE = /decline|prefer not|don'?t wish|do not wish|not to (say|answer)|rather not/i;

// Pick the option whose text best satisfies `desired`, or null if none is a confident match
// (better to leave blank and report than to select the wrong answer).
export function matchOption<T extends { text: string }>(options: T[], desired: Desired): T | null {
  if (!desired) return null;
  const norm = (s: string) => clean(s).toLowerCase();
  if (desired.mode === 'decline') {
    return options.find((o) => DECLINE_RE.test(clean(o.text))) ?? null;
  }
  if (desired.mode === 'yes' || desired.mode === 'no') {
    const wantYes = desired.mode === 'yes';
    // "not"/"am not"/"do not"/"don't" reliably marks the negative option even when it doesn't
    // start with "no" (e.g. "I am not a protected veteran").
    const isNeg = (t: string) => /^\s*no\b/.test(t) || /\b(not|am not|do not|don'?t)\b/.test(t);
    const isPos = (t: string) => (/^\s*yes\b/.test(t) || /\b(i am a|identify as|i have)\b/.test(t)) && !isNeg(t);
    const pos = options.filter((o) => isPos(norm(o.text)));
    const neg = options.filter((o) => isNeg(norm(o.text)) && !DECLINE_RE.test(o.text));
    const pick = wantYes ? pos : neg;
    return pick.length === 1 ? pick[0] : null; // ambiguous -> leave for the student
  }
  // value: exact-ish then substring, both directions.
  const v = norm(desired.value);
  return (
    options.find((o) => norm(o.text) === v) ??
    options.find((o) => norm(o.text).includes(v)) ??
    options.find((o) => v.includes(norm(o.text)) && norm(o.text).length > 2) ??
    null
  );
}

// ─── DOM fillers ────────────────────────────────────────────────────────────

async function fillTextField(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await randomDelay();
  el.focus();
  setNativeValue(el, value);
  el.blur();
}

function findResumeFileInput(): HTMLInputElement | null {
  const fileInputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].filter(
    (el) => !el.closest('[id*="volley"]'),
  );
  if (fileInputs.length === 0) return null;
  const scored = fileInputs.map((el) => {
    const ctx = `${controlIdentity(el)} ${el.closest('div,section,fieldset')?.textContent?.slice(0, 200) ?? ''}`.toLowerCase();
    if (/cover\s*letter/.test(ctx)) return { el, score: -1 };
    if (/resume|\bcv\b|curriculum/.test(ctx)) return { el, score: 2 };
    return { el, score: 0 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].score >= 0 ? scored[0].el : null;
}

// The optional async hook lets the caller (content.ts) draft open-ended answers via the
// backend without this module knowing anything about the network or auth.
export interface GenericFillParams {
  fullName: string;
  email?: string;
  profile: Profile;
  applicationProfile: ApplicationProfile;
  eeo?: Record<string, string>;
  resumeBlob?: Blob;
  resumeFileName?: string;
  draftAnswer?: (question: string) => Promise<string | null>;
  onProgress?: (partial: { fields_filled: number; fields_skipped: number; ai_drafted: number; pendingEssays: number }) => void;
}

export async function fillGenericApplication(params: GenericFillParams): Promise<AutofillResult> {
  const { fullName, email, applicationProfile: ap, resumeBlob, resumeFileName, draftAnswer } = params;
  const eeo = params.eeo ?? {};
  let fields_filled = 0;
  let fields_skipped = 0;
  let ai_drafted = 0;
  const skipped_reasons: string[] = [];
  const pendingDrafts: Array<{ el: HTMLTextAreaElement; question: string }> = [];
  const short = (s: string) => s.slice(0, 50).trim();

  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts[0] ?? '';
  const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

  // ── Text / email / tel / url inputs and textareas ──
  for (const el of candidateInputs()) {
    if (el.value) continue; // never overwrite what the student typed
    const id = controlIdentity(el);
    const type = (el as HTMLInputElement).type;
    const isTextarea = el instanceof HTMLTextAreaElement;

    if (NEVER_FILL_PATTERNS.some((re) => re.test(id))) {
      fields_skipped++;
      skipped_reasons.push(`sensitive field left for manual entry: "${short(id)}"`);
      continue;
    }

    // Identity-first mapping (input type beats label text).
    let value =
      type === 'email' ? email :
      type === 'tel' ? ap.phone :
      /first\s*name|given\s*name|preferred\s*name/.test(id) ? firstName :
      /last\s*name|family\s*name|surname/.test(id) ? lastName :
      /full\s*name|legal\s*name|your\s*name|^\s*name\b/.test(id) ? fullName :
      /e-?mail/.test(id) ? email :
      /phone|mobile/.test(id) ? ap.phone :
      /linkedin/.test(id) ? ap.linkedin_url :
      /github/.test(id) ? ap.github_url :
      /portfolio|personal\s*(web)?site|\bwebsite\b/.test(id) ? ap.portfolio_url :
      /\bcity\b|\blocation\b/.test(id) ? ap.address_city :
      undefined;

    // Profile-value questions that can appear as free-text (salary, DOB, citizenship, etc.).
    if (value === undefined && !isTextarea) {
      const d = desiredAnswer(id, ap, eeo);
      if (d?.mode === 'value') value = d.value;
    }

    if (value && /handle/.test(id) && /^https?:\/\//.test(value)) {
      value = value.replace(/\/+$/, '').split('/').pop() ?? value; // "linkedin.com/in/" + handle
    }

    if (value) {
      if (isAutocompleteWidget(el) && !/linkedin|github|portfolio|e-?mail/.test(id)) {
        fields_skipped++;
        skipped_reasons.push(`autocomplete field left for manual selection: "${short(id)}"`);
        continue;
      }
      await fillTextField(el, value);
      fields_filled++;
      continue;
    }

    // Open-ended written question: defer it. Drafting is an LLM round trip per box, so we
    // collect them here and fire them all in PARALLEL after the instant fields are done -
    // the structured part of the form populates immediately instead of blocking behind N
    // sequential draft calls.
    if (isTextarea) {
      if (draftAnswer) {
        pendingDrafts.push({ el, question: questionLabel(el) || id });
      } else {
        fields_skipped++;
        skipped_reasons.push(`open-ended question left blank: "${short(id)}"`);
      }
      continue;
    }

    if (id) {
      fields_skipped++;
      skipped_reasons.push(`unrecognized field left blank: "${short(id)}"`);
    }
  }

  // ── <select> dropdowns ──
  for (const select of [...document.querySelectorAll<HTMLSelectElement>('select')]) {
    if (select.closest('[id*="volley"]') || select.disabled || !isVisible(select)) continue;
    if (select.selectedIndex > 0 && select.value && !/select|choose|^$/i.test(select.options[select.selectedIndex]?.text ?? '')) continue; // already answered
    const label = questionLabel(select);
    const desired = desiredAnswer(label, ap, eeo);
    const options = [...select.options]
      .filter((o) => o.value && !/^(select|choose|please|--)/i.test(o.text.trim()))
      .map((o) => ({ text: o.text, value: o.value }));
    const match = matchOption(options, desired);
    if (match) {
      await randomDelay();
      setNativeValue(select, match.value);
      fields_filled++;
    } else if (label) {
      fields_skipped++;
      skipped_reasons.push(`dropdown left for you: "${short(label)}"`);
    }
  }

  // ── Radio groups (grouped by name) ──
  const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter(
    (el) => !el.closest('[id*="volley"]') && !el.disabled && isInteractableChoice(el),
  );
  const radioGroups = new Map<string, HTMLInputElement[]>();
  for (const r of radios) {
    const key = r.name || `__${questionLabel(r)}`;
    (radioGroups.get(key) ?? radioGroups.set(key, []).get(key)!).push(r);
  }
  for (const group of radioGroups.values()) {
    if (group.some((r) => r.checked)) continue; // already answered
    const options = group.map((r) => ({
      text: (document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.textContent ??
        r.closest('label')?.textContent ?? r.getAttribute('aria-label') ?? r.value ?? '').trim(),
      el: r,
    }));
    // Derive the question stem AFTER the options, so it can subtract them from the container.
    const label = groupQuestionText(group, options.map((o) => o.text));
    const desired = desiredAnswer(label, ap, eeo);
    const match = matchOption(options, desired);
    if (match) {
      await randomDelay();
      checkChoice(match.el);
      fields_filled++;
    } else if (label) {
      fields_skipped++;
      skipped_reasons.push(`radio question left for you: "${short(label)}"`);
    }
  }

  // ── Checkboxes: grouped by shared `name`, exactly like radios above - Greenhouse-style
  //    "mark all that apply" EEO questions (gender/race/orientation) render as N checkboxes
  //    that all share one `name`, so a group of >1 is a multi-select question needing the
  //    GROUP's text (groupQuestionText), not any one option's own label. A group of exactly 1
  //    is a standalone factual yes-eligibility or legal-agreement checkbox, handled the same
  //    way as before. ──
  const checkboxGroups = new Map<string | HTMLInputElement, HTMLInputElement[]>();
  for (const cb of [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]) {
    if (cb.closest('[id*="volley"]') || cb.disabled || cb.checked || !isInteractableChoice(cb)) continue;
    const key = cb.name || cb; // unnamed checkboxes each form their own group of one
    (checkboxGroups.get(key) ?? checkboxGroups.set(key, []).get(key)!).push(cb);
  }
  for (const group of checkboxGroups.values()) {
    if (group.length > 1) {
      const options = group.map((cb) => ({
        text: (document.querySelector(`label[for="${CSS.escape(cb.id)}"]`)?.textContent ??
          cb.closest('label')?.textContent ?? cb.getAttribute('aria-label') ?? cb.value ?? '').trim(),
        el: cb,
      }));
      const label = groupQuestionText(group, options.map((o) => o.text));
      const desired = desiredAnswer(label, ap, eeo);
      const match = matchOption(options, desired);
      if (match) {
        await randomDelay();
        checkChoice(match.el);
        fields_filled++;
      } else if (label) {
        fields_skipped++;
        skipped_reasons.push(`checkbox question left for you: "${short(label)}"`);
      }
      continue;
    }

    const cb = group[0];
    const id = controlIdentity(cb) || questionLabel(cb);
    const isAgreement = /agree|consent|terms|privacy|certif|accurate|acknowledg|authorize .*contact|i confirm/.test(id);
    const desired = isAgreement ? null : desiredAnswer(id, ap, eeo);
    if (desired?.mode === 'yes') {
      await randomDelay();
      checkChoice(cb);
      fields_filled++;
    } else if (isAgreement) {
      fields_skipped++;
      skipped_reasons.push(`agreement checkbox left for you to confirm: "${short(id)}"`);
    }
  }

  // ── Resume file ──
  if (resumeBlob && resumeFileName) {
    const input = findResumeFileInput();
    if (input) {
      await randomDelay();
      const file = new File([resumeBlob], resumeFileName, { type: 'application/pdf' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      fields_filled++;
    } else {
      fields_skipped++;
      skipped_reasons.push('resume: no file input found on this form');
    }
  } else {
    fields_skipped++;
    skipped_reasons.push('resume: no generated resume file available');
  }

  // ── Open-ended answers: all instant fields are filled by now, so draft every textarea
  //    CONCURRENTLY (each is an independent LLM round trip). Wall-clock is the slowest single
  //    draft, not the sum - a form with 4 essay boxes takes ~1 draft's time, not 4. Each result
  //    is written into the DOM and reported via onProgress as soon as IT resolves, rather than
  //    batching behind Promise.all so the student watches essays fill in one at a time. ──
  if (pendingDrafts.length > 0) {
    let pendingEssays = pendingDrafts.length;
    params.onProgress?.({ fields_filled, fields_skipped, ai_drafted, pendingEssays });

    await Promise.all(
      pendingDrafts.map(async ({ el, question }) => {
        let drafted: string | null = null;
        try {
          drafted = (await params.draftAnswer!(question))?.trim() || null;
        } catch {
          drafted = null;
        }

        if (drafted) {
          await fillTextField(el, drafted);
          markForReview(el);
          ai_drafted++;
          fields_filled++;
        } else {
          fields_skipped++;
          skipped_reasons.push(`open-ended question left blank: "${short(question)}"`);
        }

        pendingEssays--;
        params.onProgress?.({ fields_filled, fields_skipped, ai_drafted, pendingEssays });
      }),
    );
  }

  if (ai_drafted > 0) {
    skipped_reasons.unshift(`${ai_drafted} open-ended answer${ai_drafted === 1 ? '' : 's'} AI-drafted — review before submitting`);
  }

  return { ats_name: 'generic', fields_filled, fields_skipped, skipped_reasons };
}

// Visually mark an AI-drafted field so the student can't miss that it needs review.
function markForReview(el: HTMLElement) {
  el.style.outline = '2px solid #f59e0b';
  el.style.outlineOffset = '1px';
  const badge = document.createElement('div');
  badge.textContent = '✎ AI draft — review before submitting';
  badge.style.cssText =
    'font:600 11px -apple-system,BlinkMacSystemFont,sans-serif;color:#b45309;margin-top:4px;';
  el.insertAdjacentElement('afterend', badge);
}
