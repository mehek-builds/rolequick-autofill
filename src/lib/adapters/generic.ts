import type { ApplicationProfile, AutofillResult, Profile } from '../types';
import {
  commitChoice as checkChoice,
  isComboboxControl,
  openCombobox,
  pickComboOption,
  closeOpenCombobox,
} from './shared/dom';
import {
  dateOrderCandidates,
  formatDate,
  isDateControl,
  parseStoredDate,
  valueHoldsDate,
  type DateOrder,
  type DateParts,
} from './shared/dates';

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

// Drive a combobox / react-select control to the desired answer: open it, read its rendered
// options, and click the match. Returns 'filled' on a confident selection, 'skipped' otherwise
// (menu never opened, or no option matched - better to leave it for the student than guess).
async function fillComboboxFor(trigger: HTMLElement, desired: Desired): Promise<'filled' | 'skipped'> {
  if (!desired) return 'skipped';
  const typeahead =
    desired.mode === 'value' ? desired.value : desired.mode === 'oneof' ? desired.values[0] : undefined;
  const options = await openCombobox(trigger, typeahead);
  if (options.length === 0) { closeOpenCombobox(); return 'skipped'; }
  const match = matchOption(options, desired);
  if (!match) { closeOpenCombobox(); return 'skipped'; }
  await pickComboOption(match);
  return 'filled';
}

function candidateInputs(): Array<HTMLInputElement | HTMLTextAreaElement> {
  // `number` and `date` are included so a numeric salary field or a native date-of-birth picker
  // is actually considered (and, if unmapped, counted as skipped) instead of being invisible to
  // the filler and left silently blank with no skip reason.
  return [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="date"], input:not([type]), textarea',
  )].filter((el) => !el.closest('[id*="rolequick"]') && !el.disabled && !el.readOnly && isVisible(el));
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
  // Strip a trailing separator run (whitespace, pipe, en-dash, or hyphen) left after the site
  // suffix is removed. The en-dash is matched via a Unicode escape (not a literal glyph) so the
  // source stays free of em/en dash characters while still stripping a real en-dash separator.
  if (site && title.endsWith(site)) title = title.slice(0, title.length - site.length).replace(/[\s|\u2013-]+$/, '');
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
  | { mode: 'value'; value: string; exact?: true }
  | { mode: 'oneof'; values: string[]; exact?: true }
  | { mode: 'yes' }
  | { mode: 'no' }
  | { mode: 'decline' }
  | null;

// `exact: true` opts a question OUT of the single-hit widening in matchOption - only an exact
// option match commits, anything else is left for the student. Set it wherever "close enough" is
// the wrong answer rather than a helpful one. See eeoAnswer.
export function eeoAnswer(pref: string | undefined): Desired {
  // Demographics are exact-match-only (Mehek's ruling, 2026-07-17, closing the R-018 judgement
  // call). The widening that usefully turns "Korea" -> "Korea, Republic of" on a country dropdown
  // is actively wrong on a protected characteristic: a student who stored "Male" must never be
  // silently committed to "Male (cisgender)" on a form offering no plain "Male", because that is
  // a different statement about them, not a formatting variant of the same one. A demographic
  // field is exactly where a blank left for the student beats a confident near-miss - and an
  // unmatched EEO option is safe to leave, since these questions are near-universally optional
  // or carry a decline option. Country-style widening keeps its own rule, unchanged.
  return pref && pref.trim() ? { mode: 'value', value: pref.trim(), exact: true } : { mode: 'decline' };
}

// Work-eligibility questions (work authorization AND visa sponsorship) are location-scoped
// ("legally authorized to work in the location where this role is based?", "require sponsorship
// to work in the US?") but the profile stores single global flags, so deriving Yes/No shipped a
// false declaration on non-local roles (live QA 2026-07-16, Lever/Xsolla; sponsorship extended to
// always-ask on Mehek's 2026-07-16 decision). RoleQuick NEVER answers either: the adapters skip
// the question with workEligibilitySkipReason(), whose "left for" wording makes the auto-submit
// gate HOLD (autosubmit-gate.ts REVIEW_FLAG) while it sits unanswered. This is the ONE classifier
// every adapter must use: whitespace-tolerant (\s+, labels keep raw internal whitespace from
// textContent), both spellings (authorized/authorised), case-insensitive.
//
// The sponsorship half must stay tied to sponsorship-OF-WORK wording (require/need/visa/
// immigration/without/employment near "sponsor", or "sponsorship required"). A bare `sponsor`
// alternative matched any label merely containing the word, and adapters pass whole-container
// text as the label, so "How did you hear about us? [LinkedIn, Sponsored ad, ...]" was classified
// as a work-eligibility question: skipped, flagged "left for you", and holding auto-submit.
export const WORK_ELIGIBILITY_QUESTION =
  /authori[sz](?:ed|ation)\s+to\s+work|legally\s+authori[sz]ed|right\s+to\s+work|work\s+authori[sz]|(?:requir\w*|need\w*|visa|immigration|without|employment)\s+(?:\w+\s+){0,3}sponsor|sponsor\w*\s+(?:\w+\s+){0,3}(?:requir\w*|need\w*)/i;

// The one skip-reason builder for work-eligibility questions. "left for" is load-bearing: it is
// what the auto-submit gate's REVIEW_FLAG matches, so every adapter must use this instead of
// hand-typing.
export function workEligibilitySkipReason(label: string): string {
  return `work-eligibility question left for you: "${label.slice(0, 60)}"`;
}

// A question asking for a profile LINK ("Please provide a link to your GitHub") must never reach
// the open-ended AI drafter, which answers it with a prose paragraph instead of a URL (live QA
// 2026-07-16, Xsolla/Lever). Two properties make that safe, and the adapters' old inline
// `linkTarget !== undefined` checks had neither:
//   1. The QUESTION is classified independently of whether a URL is stored. An unset github_url
//      must still terminate the block (blank + flagged), not fall through to the drafter - which
//      is precisely what `?: undefined` did, since "no URL" and "not a link question" collapsed
//      into the same value.
//   2. Callers must query textarea too. A link question rendered as a textarea is the ONLY way it
//      reaches the drafter at all, so an input-only selector cannot fix this bug.
// Returns the resolved url (possibly undefined) so the caller can fill it or flag it, or null when
// this is not a link question at all.
// `asksForLink` exists because a textarea is ambiguous in a way an input is not. "Please provide a
// link to your GitHub" rendered as a textarea is a URL field (fill it). "Tell us about your
// portfolio" rendered as a textarea is an ESSAY (leave it for the drafter). Naming the platform is
// not enough to tell those apart; asking for a link/URL/profile is. Callers therefore accept a
// textarea ONLY when asksForLink is true, while a plain text input stays unconditional (an input
// cannot hold an essay, so a field merely labelled "GitHub" is still a URL field).
export type LinkQuestion = { field: 'linkedin' | 'github' | 'portfolio'; url?: string; asksForLink: boolean };

// "How did you hear about us?" and friends. Shared by linkQuestion (to refuse them) and
// desiredAnswer (to answer them), so the two can never drift apart on what counts as a referral.
export const REFERRAL_QUESTION = /how did you hear|referral source|hear about (this|us|the)|source of/i;

export function linkQuestion(label: string, ap: ApplicationProfile): LinkQuestion | null {
  // A referral question is NOT a link question, even though it routinely names LinkedIn or the
  // company website among its OPTIONS - and adapters pass whole-container text as the label, so
  // those option words land here. Without this guard, "How did you hear about us? (e.g. LinkedIn,
  // referral, job board)" classified as a linkedin link question and, on the four adapters that
  // resolve links before known answers, wrote the student's LinkedIn URL into the referral box.
  // lever.ts dodged this by ordering its link branch after the known-answer branch; guarding the
  // classifier itself makes every adapter safe regardless of branch order.
  if (REFERRAL_QUESTION.test(label)) return null;
  const asksForLink = /\b(link|links|url|urls|profile|handle|username)\b/i.test(label);
  if (/linkedin/i.test(label)) return { field: 'linkedin', url: ap.linkedin_url, asksForLink };
  if (/github/i.test(label)) return { field: 'github', url: ap.github_url, asksForLink };
  if (/portfolio|personal\s+(?:web)?site|\bwebsite\b/i.test(label))
    return { field: 'portfolio', url: ap.portfolio_url, asksForLink };
  return null;
}

// "left for" is load-bearing here too: it is what the auto-submit gate's REVIEW_FLAG matches, so a
// link question we could not fill HOLDS the countdown rather than submitting an empty field.
export function linkSkipReason(label: string): string {
  return `link question left for you (no URL in your profile): "${label.slice(0, 60)}"`;
}

export function desiredAnswer(label: string, ap: ApplicationProfile, eeo: Record<string, string>): Desired {
  // Lowercase here rather than trust the caller. Most rules below are case-SENSITIVE (no /i),
  // unlike the /i siblings linkQuestion and WORK_ELIGIBILITY_QUESTION, so they only worked because
  // all five adapters happen to pre-lowercase in labelTextFor. A future caller passing a raw label
  // would silently skip every EEO / citizenship / age rule and return null: a blank field with no
  // skip reason, which is the exact silent-blank class the location and link fixes exist to kill.
  const l = label.toLowerCase();
  if (NEVER_FILL_PATTERNS.some((re) => re.test(l))) return null;

  // Never answer work-authorization or sponsorship questions (see WORK_ELIGIBILITY_QUESTION
  // above). needs_sponsorship and work_authorized stay on the profile for the student's own
  // reference but are never written into a form.
  if (WORK_ELIGIBILITY_QUESTION.test(l)) return null;
  // Affirmative age-of-majority only. Two classes of false Yes are excluded:
  //   - negated phrasings ("are you UNDER 18?", "younger than 18 years"), which would answer Yes
  //     to being a minor;
  //   - the number 18 used for TENURE rather than age. "Do you have 18+ months of experience?" and
  //     "at least 18 years of experience" both satisfied the alternatives above, so RoleQuick
  //     claimed experience the student never stated - the same class of false declaration the
  //     always-ask work-eligibility rule exists to prevent.
  if (
    /(at least|over|older than)\s*(18|eighteen)|age of majority|18\s*\+|\b18\s+years?\b/.test(l) &&
    !/\bunder\b|younger than|below|less than|experience|\bmonths?\b|tenure/.test(l)
  )
    return { mode: 'yes' };

  // EEO / demographics: real answer if the student provided one, else decline.
  // \bgender\b (not /gender/) so "do you identify as transgender?" - a distinct yes/no
  // self-ID question we have no data for - doesn't get pulled into the gender-value rule.
  if (/\bgender\b|what is your sex\b/.test(l)) return eeoAnswer(eeo.gender);
  if (/race|ethnic/.test(l)) return eeoAnswer(eeo.race);
  if (/hispanic|latino/.test(l)) return { mode: 'decline' };
  if (/veteran|military|protected\s+veteran/.test(l)) return eeoAnswer(eeo.veteran);
  if (/disab/.test(l)) return eeoAnswer(eeo.disability);
  // Age as a demographic (a diversity-survey "what is your current age" bucket) is decline-only -
  // distinct from the "are you at least 18" eligibility check handled above, which stays a Yes.
  if (/current age|what is your age|age range|how old are you|\bage group\b/.test(l)) return { mode: 'decline' };

  // CITIZENSHIP / nationality (checked first, most specific) -> the citizenship field. Matched on
  // ANY "citizen"/"nationality" wording (e.g. "what country are you a citizen of?"), not just the
  // literal "citizenship" token, so a citizenship question can never fall through to the residence
  // rule below and get answered with the residence country (a high-stakes mis-fill for students
  // whose citizenship differs from where they live). Citizenship is often stored as a nationality
  // adjective ("Indian"), but a country dropdown lists the country ("India") and a combobox
  // typeahead filters by what is typed, so map the adjective to the country up front; oneof still
  // lets a plain-text or exact-country field accept the raw value. When citizenship is unset we
  // leave it blank rather than guess (the residence guard below stops it filling the wrong value).
  if (/citizen|nationalit/.test(l) && ap.citizenship) {
    const c = ap.citizenship.trim().toLowerCase();
    const country = NATIONALITY_TO_COUNTRY[c];
    return country ? { mode: 'oneof', values: [country, ap.citizenship] } : { mode: 'value', value: ap.citizenship };
  }
  // Country of RESIDENCE / where you are based / where you intend to work from, and bare "country"
  // location fields -> address_country (where the student lives), NOT citizenship. The leading
  // !citizen/nationality guard enforces that split: a citizenship-worded question is handled above
  // (or left blank when citizenship is unset), never answered with the residence country. "Which
  // country do you intend to work from" asks about location, not nationality; the two differ.
  if (
    !/citizen|nationalit/.test(l) &&
    /country of residence|which country|country you.{0,15}(based|reside|work from|located)|where are you based|based in which country|current country|\bcountry\b/.test(l) &&
    ap.address_country
  )
    return { mode: 'value', value: ap.address_country };
  // Referral / "how did you hear": the option set varies wildly per form (LinkedIn, Company
  // website, Job board, Other, ...), so a single value rarely matches. Try the student's own
  // answer first, then common near-synonyms, then "Other" as the safe catch-all - one of these
  // almost always exists, so the question gets answered instead of left blank.
  if (REFERRAL_QUESTION.test(l))
    return {
      mode: 'oneof',
      values: [
        ap.referral_source_default,
        'company website',
        'company careers',
        'careers page',
        'company site',
        'other',
      ].filter(Boolean) as string[],
    };
  if (/salary|compensation|desired pay|expected pay|pay expectation/.test(l) && ap.desired_salary)
    return { mode: 'value', value: ap.desired_salary };
  if (/date of birth|birth\s*date|\bdob\b/.test(l) && ap.date_of_birth)
    return { mode: 'value', value: ap.date_of_birth };
  // Term/duration BEFORE start date: "length or term/length of availability (10-14 weeks)" and
  // "how long are you available" both contain "availab", so the old single /availab/ rule poured
  // the start date into them. It answered when she can start in response to how long she can stay
  // (R-014 facet b, live on Espa). These are two questions and now two fields.
  if (TERM_QUESTION.test(l)) return ap.availability_term ? { mode: 'value', value: ap.availability_term } : null;
  // "starting date" / "earliest possible starting date" (Enpal's verbatim label) matched neither
  // "start date" nor "earliest start", so a required start-date field was never even a candidate.
  if (/availab|start(ing)?\s+date|date.*you.*start|when can you start|earliest.*start/.test(l) && ap.availability_date)
    return { mode: 'value', value: ap.availability_date };

  return null;
}

// "How long", not "when". Deliberately narrow: it must beat the /availab/ rule below it without
// swallowing a plain "When are you available to start?", which is a start-date question.
const TERM_QUESTION =
  /(length|duration|term)\b.*\bavailab|availab.*\b(length|duration|term)\b|how long.*(available|intern|stay|commit)|(weeks|months).*\b(available|internship|commit)|\bterm\s*\/?\s*length/i;

// Opt-out wordings for EEO/demographic questions. Broadened beyond "decline/prefer not" to catch
// the common "Choose not to disclose" / "I do not wish to identify" phrasings that ATSes use, so a
// required EEO field with that wording gets a decline selection instead of being left blank (which
// would block submission).
const DECLINE_RE = /decline|prefer not|don'?t wish|do not wish|wish not|rather not|choose not|not to (say|answer|disclose|identify|self.?identify)|not wish to (disclose|identify)/i;

// Common nationality adjective -> country name, so a citizenship stored as "Indian" can still
// answer a country dropdown that lists "India". Keys/values are lowercased to match `norm()`.
const NATIONALITY_TO_COUNTRY: Record<string, string> = {
  indian: 'india', american: 'united states', emirati: 'united arab emirates',
  british: 'united kingdom', canadian: 'canada', chinese: 'china', pakistani: 'pakistan',
  filipino: 'philippines', nigerian: 'nigeria', german: 'germany', french: 'france',
  singaporean: 'singapore', australian: 'australia', mexican: 'mexico', brazilian: 'brazil',
  japanese: 'japan', korean: 'south korea', irish: 'ireland', spanish: 'spain', italian: 'italy',
};

// Pick the option whose text best satisfies `desired`, or null if none is a confident match
// (better to leave blank and report than to select the wrong answer).
export function matchOption<T extends { text: string }>(options: T[], desired: Desired): T | null {
  if (!desired) return null;
  const norm = (s: string) => clean(s).toLowerCase();
  // Option text is page-authored, so a value like "Korea, Republic of" must not be spliced into a
  // RegExp as syntax.
  const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (desired.mode === 'decline') {
    return options.find((o) => DECLINE_RE.test(clean(o.text))) ?? null;
  }
  if (desired.mode === 'yes' || desired.mode === 'no') {
    const wantYes = desired.mode === 'yes';
    // "not"/"am not"/"do not"/"don't"/"require sponsorship" reliably marks the negative option
    // even when it doesn't start with "no" (e.g. "I am not a protected veteran", "I will require
    // sponsorship").
    const isNeg = (t: string) =>
      /^\s*no\b/.test(t) || /\b(not|am not|do not|don'?t)\b/.test(t) || /require(s|d)?\s+(visa\s+)?sponsor/.test(t);
    // Positive options are often phrased as statements, not "Yes" - "I am a protected veteran",
    // so match those too, as long as they aren't negated. The work-auth statement alternatives
    // ("I am authorized to work...") were removed with the always-ask work-auth change: no auth
    // question produces a yes/no Desired anymore, and keeping them only let "authorization"
    // wording inside a sponsorship question's options get mis-clicked as the positive.
    const isPos = (t: string) =>
      (/^\s*yes\b/.test(t) || /\b(i am a|identify as|i have)\b/.test(t)) && !isNeg(t);
    const pos = options.filter((o) => isPos(norm(o.text)));
    const neg = options.filter((o) => isNeg(norm(o.text)) && !DECLINE_RE.test(o.text));
    const pick = wantYes ? pos : neg;
    return pick.length === 1 ? pick[0] : null; // ambiguous -> leave for the student
  }
  // value / oneof: match the (first) value that lands an unambiguous option. exact match first,
  // then substring in either direction - but only when the substring match is UNAMBIGUOUS. "Korea"
  // against a list holding "Korea, Republic of" and "Korea, Democratic People's Republic of" must
  // not silently commit whichever comes first; two candidates means leave it for the student.
  const matchValue = (raw: string): T | null => {
    const base = norm(raw);
    if (!base) return null;
    // Exact-only questions (EEO/demographics) stop here: no widening, no nationality mapping, no
    // reverse match. Either the form offers the student's own stored answer verbatim, or nobody
    // answers it for them. See eeoAnswer for why demographics get this and countries don't.
    if (desired.exact) return options.find((o) => norm(o.text) === base) ?? null;
    // A citizenship stored as a nationality adjective ("Indian") will never match a country
    // option ("India"), so also try the mapped country name - lets country / "which country do
    // you intend to work from" questions fill from a nationality-valued citizenship field.
    const candidates = NATIONALITY_TO_COUNTRY[base] ? [base, NATIONALITY_TO_COUNTRY[base]] : [base];
    for (const v of candidates) {
      const exact = options.find((o) => norm(o.text) === v);
      if (exact) return exact;
      // Word-boundary substring, NEVER a bare fragment. A plain .includes() mis-selects on a
      // coincidental letter run: "asian" sits inside "cauc-asian" and "male" inside "fe-male", so
      // an Asian applicant against a [White/Caucasian, ...] taxonomy silently got Caucasian ticked,
      // and a male applicant got Female - with contains.length === 1 it committed confidently
      // rather than leaving it for the student. The boundary still matches the legitimate widening
      // case ("Korea" -> "Korea, Republic of").
      const vRe = new RegExp(`\\b${escapeRe(v)}\\b`);
      const contains = options.filter((o) => vRe.test(norm(o.text)));
      if (contains.length === 1) return contains[0];
      if (contains.length > 1) return null; // ambiguous -> leave for the student
      const reverse = options.filter((o) => {
        const ot = norm(o.text);
        return ot.length > 2 && new RegExp(`\\b${escapeRe(ot)}\\b`).test(v);
      });
      if (reverse.length === 1) return reverse[0];
    }
    return null;
  };
  if (desired.mode === 'oneof') {
    for (const val of desired.values) {
      const m = matchValue(val);
      if (m) return m;
    }
    return null;
  }
  return matchValue(desired.value);
}

// ─── DOM fillers ────────────────────────────────────────────────────────────

// Why the stored value could not be written as a date. The "left for" wording is load-bearing:
// autosubmit-gate's REVIEW_FLAG matches it, so an unwritable date HOLDS auto-submit instead of
// letting the countdown fire into a form the ATS will bounce (R-014).
export function dateSkipReason(stored: string, label: string): string {
  const why = parseStoredDate(stored)
    ? 'the field would not accept it'
    : `"${stored.slice(0, 24)}" is not an unambiguous date`;
  return `date left for you: "${label}" (${why})`;
}

// Write `parts` in `order` and report whether the widget's own state kept that exact day.
async function writeAndVerify(el: HTMLInputElement, parts: DateParts, order: DateOrder): Promise<boolean> {
  await randomDelay();
  el.focus();
  setNativeValue(el, formatDate(parts, order));
  el.blur();
  // Let a controlled component re-render before reading: React may clear a value it rejected,
  // and reading synchronously would see our own text still sitting in the box and call it a pass.
  await new Promise((r) => setTimeout(r, 60));
  return valueHoldsDate(el.value, parts, order);
}

// Write a date and PROVE it landed. Every attempt is read back, because the failure this exists to
// stop is invisible: the widget shows the text while its state holds nothing, so a write that is
// assumed to have worked is exactly how a required field reaches submit empty.
//
// Only ever writes HER date, in an order dateOrderCandidates has established is safe to try. A
// version of this probed unmasked widgets first, by writing a date that was not hers and seeing
// which order survived. It is deleted and must not come back: a controlled widget's state follows
// only a successful parse while setNativeValue moves only text, so a probe that lands cannot be
// withdrawn, and that one shipped a date from nowhere into a real application while reporting
// success. See dateOrderCandidates for why it was also unreachable.
export async function fillDateField(el: HTMLInputElement, stored: string): Promise<boolean> {
  const parts = parseStoredDate(stored);
  if (!parts) return false; // "Immediately", or an ambiguous 03/04/2026 - never guess into a date

  for (const order of dateOrderCandidates(el, parts)) {
    if (await writeAndVerify(el, parts, order)) return true;
  }

  // Nothing round-tripped. Leave the field genuinely empty rather than parked with a value the
  // form has already rejected - a visibly-filled dead field is what made this bug cost 4 round
  // trips to diagnose in the first place.
  setNativeValue(el, '');
  return false;
}

async function fillTextField(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await randomDelay();
  el.focus();
  setNativeValue(el, value);
  el.blur();
}

function findResumeFileInput(): HTMLInputElement | null {
  const fileInputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].filter(
    (el) => !el.closest('[id*="rolequick"]'),
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

    // Work-eligibility questions (auth + sponsorship) are always-ask on every control type (see
    // WORK_ELIGIBILITY_QUESTION). Checked
    // BEFORE the identity mapping: "authorized to work in the location where this role is based"
    // contains "location", which would otherwise fill the student's city into the box; and a
    // work-auth textarea must never reach the AI-draft path (a drafted legal claim would land in
    // the field even though the draft-review hold stops auto-submit).
    if (WORK_ELIGIBILITY_QUESTION.test(id) || (isTextarea && WORK_ELIGIBILITY_QUESTION.test(questionLabel(el)))) {
      fields_skipped++;
      skipped_reasons.push(workEligibilitySkipReason(questionLabel(el) || id));
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

    // Combobox / react-select (city, country, work-auth yes/no, EEO rendered as a styled
    // dropdown rather than a native <select>): open it and click the matching option. Poking
    // .value does nothing to these, so they were previously collected and skipped. Links and
    // email stay plain text fields even if they carry a combobox role.
    if (isComboboxControl(el) && !/linkedin|github|portfolio|e-?mail/.test(id)) {
      const desired: Desired = value !== undefined ? { mode: 'value', value } : desiredAnswer(id, ap, eeo);
      const res = await fillComboboxFor(el as HTMLElement, desired);
      if (res === 'filled') {
        fields_filled++;
      } else if (desired) {
        fields_skipped++;
        skipped_reasons.push(`dropdown left for you: "${short(id)}"`);
      } else if (id) {
        fields_skipped++;
        skipped_reasons.push(`unrecognized field left blank: "${short(id)}"`);
      }
      continue;
    }

    // Date fields go through the formatter, never the plain text filler: a raw locale string is
    // silently dropped by a picker expecting the other order, leaving a field that LOOKS answered
    // and blocks the submit (R-014). fillDateField reads the value back and only counts a write
    // that actually committed.
    if (value && isDateControl(el, id)) {
      if (await fillDateField(el as HTMLInputElement, value)) {
        fields_filled++;
      } else {
        fields_skipped++;
        skipped_reasons.push(dateSkipReason(value, short(id)));
      }
      continue;
    }

    if (value) {
      await fillTextField(el, value);
      fields_filled++;
      continue;
    }

    // Open-ended written question: defer it. Drafting is an LLM round trip per box, so we
    // collect them here and fire them all in PARALLEL after the instant fields are done -
    // the structured part of the form populates immediately instead of blocking behind N
    // sequential draft calls.
    if (isTextarea) {
      // Work-auth textareas never reach here: the always-ask intercept at the top of this loop
      // skips them before the identity mapping, so nothing work-auth can be AI-drafted.
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
    if (select.closest('[id*="rolequick"]') || select.disabled || !isVisible(select)) continue;
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
    (el) => !el.closest('[id*="rolequick"]') && !el.disabled && isInteractableChoice(el),
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
    if (cb.closest('[id*="rolequick"]') || cb.disabled || cb.checked || !isInteractableChoice(cb)) continue;
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
    } else if (WORK_ELIGIBILITY_QUESTION.test(id)) {
      // A standalone "I am legally authorized to work in ..." checkbox: desiredAnswer returns null
      // for work-auth labels, and without this branch the loop fell through with NO skip reason,
      // so the auto-submit gate never held on the unanswered declaration (review 2026-07-16).
      fields_skipped++;
      skipped_reasons.push(workEligibilitySkipReason(id));
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
    skipped_reasons.unshift(`${ai_drafted} open-ended answer${ai_drafted === 1 ? '' : 's'} AI-drafted, review before submitting`);
  }

  return { ats_name: 'generic', fields_filled, fields_skipped, ai_drafted, skipped_reasons };
}

// Visually mark an AI-drafted field so the student can't miss that it needs review.
function markForReview(el: HTMLElement) {
  el.style.outline = '2px solid #f59e0b';
  el.style.outlineOffset = '1px';
  const badge = document.createElement('div');
  badge.textContent = '✎ AI draft: review before submitting';
  badge.style.cssText =
    'font:600 11px -apple-system,BlinkMacSystemFont,sans-serif;color:#b45309;margin-top:4px;';
  el.insertAdjacentElement('afterend', badge);
}
