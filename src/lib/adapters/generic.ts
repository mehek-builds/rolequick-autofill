import type { ApplicationProfile, AutofillResult, Profile } from '../types';
import {
  commitChoice as checkChoice,
  isComboboxControl,
  openCombobox,
  pickComboOption,
  closeOpenCombobox,
  unattachableDocumentReasons,
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
// The salary rule (R-031 + R-011): median of the posting's own stated range first, then the
// currency-gated stored answer. Pure and shared, so this adapter, the ATS adapters and the
// background all read the same decision.
import { resolveSalary, storedSalaryOf } from './salary';

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
  // innerText when the environment renders (real browsers), textContent when it does not
  // (jsdom, where innerText is undefined and .trim() on it would throw).
  return (document.body.innerText ?? document.body.textContent ?? '').trim().slice(0, 12000);
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

// EEO / voluntary self-identification. ashby.ts's variant, which is the broadest of the five
// inline copies in the adapters, hoisted so classifyField does not become a sixth.
// NOTE: lever/greenhouse/workday/linkedin still carry their own narrower
// /gender|race|ethnicity|veteran|disability/i. Migrating them to this one is worth doing but is
// NOT a no-op - it would route strictly more blocks to a decline - so it needs its own change
// with its own live check, not a silent piggyback on harvest.
// `\bgender\b` and not /gender/ is deliberate and predates this: "do you identify as transgender?"
// is a distinct self-ID question we have no data for, and must not be pulled into the gender rule.
export const EEO_QUESTION =
  /\bgender\b|what is your sex\b|race|ethnicit|hispanic|latino|veteran|military|disab|sexual orientation|communities|identify with|current age|what is your age|age range|how old are you|\bage group\b/i;

// Every profile field a real application form can legitimately teach us.
//
// READ THE ABSENCES. There is deliberately no `work_authorized`, no `needs_sponsorship` and no
// `eeo_prefs` member. Harvest is driven entirely by this type, so those fields are not merely
// checked for and rejected - they are UNREPRESENTABLE. No classifier bug, no regex edit, and no
// future contributor adding a branch can produce one, because there is no value to return.
// That is the strongest available form of the R-004 fix: the bug that put a false legal
// declaration on a live application cannot be re-expressed here.
export type ProfileKey =
  | 'phone'
  | 'address_city'
  | 'address_state'
  | 'address_zip'
  | 'address_country'
  | 'linkedin_url'
  | 'github_url'
  | 'portfolio_url'
  | 'citizenship'
  | 'date_of_birth'
  | 'availability_date'
  | 'availability_term'
  | 'desired_salary'
  | 'gpa'
  | 'gpa_scale'
  | 'major'
  | 'referral_source_default';

/**
 * Is this a question RoleQuick must never answer AND never learn?
 *
 * The single source of refusal truth, exported because harvest has to ask the same question of a
 * control's own label AND of its surrounding question stem: a work-auth question rendered as a
 * textarea only reveals itself through the stem. Two copies of these regexes would drift, and the
 * drift would silently re-open R-004.
 */
export function isRefusedQuestion(label: string): boolean {
  const l = label ?? '';
  return (
    NEVER_FILL_PATTERNS.some((re) => re.test(l)) || WORK_ELIGIBILITY_QUESTION.test(l) || EEO_QUESTION.test(l)
  );
}

/**
 * What profile field is this control asking about? Returns the KEY, never a value.
 *
 * The single source of field identity, with two consumers that must never disagree:
 * `desiredAnswer` (fill: key -> look up the stored value) and harvest (read: key -> store what the
 * student typed). Two copies of these regexes would drift, and the drift would be invisible until
 * RoleQuick filled one field and learned a different one.
 *
 * Why this exists rather than reusing desiredAnswer: desiredAnswer's branches are guarded on the
 * value being present (`&& ap.desired_salary`), so on an empty profile - which is exactly the
 * harvest case - it returns null for salary, DOB, citizenship and country alike. "No salary
 * stored" and "not a salary question" collapse into one answer. linkQuestion was already
 * refactored to this shape after that exact collapse shipped a bug; this generalises it.
 *
 * `label` must already be lowercased by the caller (questionLabel/controlIdentity both do).
 * `type` is the input's type attribute, which beats label text where it exists.
 */
export function classifyField(label: string, type?: string): ProfileKey | null {
  const l = label ?? '';

  // Refusals first, and the order is load-bearing. A work-auth question CONTAINS words that map
  // elsewhere - "authorized to work in the LOCATION where this role is based" would otherwise
  // classify as address_city, and "...in the COUNTRY where this role is based" as
  // address_country. That mis-mapping is R-004's exact shape. Refuse before mapping, always.
  if (isRefusedQuestion(l)) return null;

  // Input type beats label text where the browser already told us what this is.
  if (type === 'tel') return 'phone';

  // Citizenship before residence: "country of citizenship" contains "country".
  if (CITIZENSHIP_QUESTION.test(l)) return 'citizenship';
  if (RESIDENCE_QUESTION.test(l)) return 'address_country';

  if (REFERRAL_QUESTION.test(l)) return 'referral_source_default';
  if (SALARY_QUESTION.test(l)) return 'desired_salary';
  if (DOB_QUESTION.test(l)) return 'date_of_birth';
  // Term BEFORE start date, exactly as desiredAnswer orders them (R-014): "length or term/length
  // of availability" and "how long are you available" both contain "availab", so a start-date
  // rule that ran first would swallow them - which is the bug R-014 fixed on a live Espa form.
  if (TERM_QUESTION.test(l)) return 'availability_term';
  if (START_DATE_QUESTION.test(l)) return 'availability_date';

  if (/linkedin/i.test(l)) return 'linkedin_url';
  if (/github/i.test(l)) return 'github_url';
  if (/portfolio|personal\s*(web)?site|\bwebsite\b/i.test(l)) return 'portfolio_url';

  // Academic. "grade average" / "predicted classification" are what a UK intern form asks; a
  // bare "gpa" is the US phrasing.
  if (/\bgpa\b|grade average|grade point/i.test(l)) return 'gpa';
  if (/gpa scale|out of.*(4\.0|100)|grading scale/i.test(l)) return 'gpa_scale';
  if (/\bmajor\b|field of study|course of study|degree subject/i.test(l)) return 'major';

  if (/phone|mobile/i.test(l)) return 'phone';
  // State before city, because the shapes overlap and the MOST specific unit wins: a bare
  // "Location" only means city when no more specific unit is named, so "Location / State /
  // Province" must land on state, not on the \blocation\b alternative below. Same doctrine as
  // country before state (RESIDENCE_QUESTION runs well above) and citizenship before residence.
  // The lookahead keeps "state" the NOUN: "please state your current location" is a city question
  // that merely uses the verb, and without the guard it would classify as address_state. No
  // plural: "are you located in the United States?" names a country, not a state field.
  if (/\b(state|province|prefecture)\b(?!\s+(?:your|the|you|it|why|how|what|when|where))|state\s*\/\s*province/i.test(l))
    return 'address_state';
  // The phrase alternatives are R-002's: live misses were question-shaped labels ("where are you
  // currently living?") that a bare \bcity\b never matched. "where are you based" classifies as
  // address_country first (RESIDENCE_QUESTION), which is also the order the R-002 branch chose.
  if (/\b(city|town)\b|\blocation\b|where are you (currently )?(located|living|based)|current location|where do you live/i.test(l))
    return 'address_city';
  if (/zip|postal/i.test(l)) return 'address_zip';

  return null;
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

// "When can you start", broadened by R-014: "starting date" / "earliest possible starting date"
// (Enpal's verbatim label) matched neither "start date" nor "earliest start". Hoisted out of
// desiredAnswer so classifyField reads the SAME regex - two copies would drift, and the drift is
// invisible: RoleQuick would fill one field and learn a different one.
export const START_DATE_QUESTION =
  /availab|start(ing)?\s+date|date.*you.*start|when can you start|earliest.*start/i;
const SALARY_QUESTION = /salary|compensation|desired pay|expected pay|pay expectation/i;
const DOB_QUESTION = /date of birth|birth\s*date|\bdob\b/i;
const CITIZENSHIP_QUESTION = /citizen|nationalit/i;
// The gap is {0,20} and the verb stem is `resid`, both for ElevenLabs' live "Country you're
// currently residing in" family: the contraction plus an adverb eats most of a 15-char gap, and
// "residing"/"residence" share no full word with "reside". The bare `country.{0,20}(residing|
// residence)` alternative catches the same phrasing with the pronoun dropped (R-002).
const RESIDENCE_QUESTION =
  /country of residence|which country|country you.{0,20}(based|resid|work from|located)|where are you based|based in which country|current country|country.{0,20}(residing|residence)|\bcountry\b/i;

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

// Does this question ask for a link at all, whatever it is a link TO? R-008 reopened through
// R-033's drafter (audit 2026-07-17): "Share a link to something you've built" fires
// isOpenEndedQuestion on `share\b`, names no platform linkQuestion knows, and classifyField has
// no generic-link key - so the R-033 gate drafted a PROSE paragraph into a URL-expecting input.
// A question that asks for a link/URL is never draftable as prose; the gate flags it instead
// (linkSkipReason, which holds auto-submit).
//
// Deliberately LIGHTER than linkQuestion's own asksForLink, which also matches
// profile/handle/username: those words are fine inside a platform-named link question, but as a
// drafter veto they would flag "how do you handle conflict" - a genuine essay ask - trading a
// working draft for a hold. links/urls only.
export const GENERIC_LINK_ASK = /\b(links?|urls?)\b/i;

// ── R-030 instrumentation: observation ONLY, never a behavior change ──
// linkQuestion commits on a keyword anywhere in the label, so "Do you have experience with GitHub
// Actions?" rendered as a text input would get the GitHub URL (R-030, zero live reproductions so
// far). The register forbids guessing a guard here: two guards in a row invented against
// hypotheticals each produced the opposite bug, and asksForLink is provably not the discriminator
// (see the R-030 entry). Its cheapest next step is exactly this: record the labels of the
// population that fills a URL unconditionally - linkQuestion non-null AND asksForLink false AND
// the control is input[type=text] - ship them with the autofill telemetry, and let one real label
// decide what the fix even is. Do NOT grow this into a veto or a gate; that is the documented trap.
const r030CandidateLabels: string[] = [];

// Called by each adapter right where it resolves the control for a link question. Pure recording:
// it must never influence what fills. (input[type=url] is excluded on purpose - the browser typed
// it as a URL field, so filling a URL there is not R-030's shape.)
export function noteLinkFillCandidate(label: string, link: LinkQuestion, control: Element | null): void {
  if (link.asksForLink) return;
  if (!control || control.tagName !== 'INPUT') return;
  if ((control as HTMLInputElement).type !== 'text') return;
  r030CandidateLabels.push(label.slice(0, 200));
}

// Drained by content.ts once per fill run and attached to the AUTOFILL_EVENT payload only when
// non-empty. Drain-and-clear, so labels from one application can never leak into the next run's
// telemetry.
export function drainR030CandidateLabels(): string[] {
  return r030CandidateLabels.splice(0, r030CandidateLabels.length);
}

// A question asking WHERE the student lives (city / state / country of residence). Live QA
// 2026-07-16 left a required location field blank on 3 of 12 real forms (Monzo "Location (City)*",
// ElevenLabs "Location* / Country you're currently residing in", Global Relay "Country*") while
// filling it on Abound - so the misses were about label and control SHAPE, not a missing profile.
// The same two holes that produced the link bug (R-008) produced this one, which is why this
// classifier is shaped exactly like linkQuestion:
//   1. The QUESTION is classified independently of whether a value is stored. An unset
//      address_country must still terminate the block (blank + flagged), not fall through - the
//      old inline rules required `ap.address_country` to even recognise a country question, so an
//      unset value looked identical to "not a location question" and the field was left blank
//      SILENTLY, with no skip reason. That silence is the actual defect: with nothing flagged the
//      auto-submit gate does not hold, and the student first learns of the empty required field
//      when the form bounces at submit.
//   2. Callers must handle the combobox shape. Every one of the three live misses was a
//      react-select / autocomplete control, and the old label rules were anchored to plain inputs
//      (Ashby's `/^(location|city)\b/` could not even match a label that opens with "Country").
// Returns the resolved value (possibly undefined) so the caller can fill it or flag it, or null
// when this is not a location question at all.
export type LocationQuestion = { field: 'city' | 'state' | 'country'; value?: string };

export function locationQuestion(label: string, ap: ApplicationProfile): LocationQuestion | null {
  // Citizenship is a DIFFERENT question with a different answer, and desiredAnswer already owns it
  // (a student whose citizenship differs from where she lives is the whole reason that split
  // exists). Guard first so "what country are you a citizen of?" can never resolve to residence.
  if (/citizen|nationalit/i.test(label)) return null;
  // A location-scoped work-eligibility question ("which country are you authorized to work in?")
  // names a country but is an always-ask LEGAL question, not a location field. Answering it from
  // address_country is precisely the R-004 CRITICAL failure (a global profile flag mapped onto a
  // location-scoped legal question, shipping a false declaration). It must fall through to
  // WORK_ELIGIBILITY_QUESTION and be left for the student.
  if (WORK_ELIGIBILITY_QUESTION.test(label)) return null;
  // Field identity is delegated to classifyField, the same classifier harvest reads with, so a
  // label RoleQuick fills as a city can never be harvested back as a country. classifyField
  // re-checks the two refusals above internally (plus EEO and never-fill), so the delegation
  // cannot weaken them; they stay spelled out here, first, because this ordering is the R-004
  // lock and must survive any future classifyField edit.
  switch (classifyField(label.toLowerCase())) {
    case 'address_country':
      return { field: 'country', value: ap.address_country };
    case 'address_state':
      return { field: 'state', value: ap.address_state };
    case 'address_city':
      return { field: 'city', value: ap.address_city };
    default:
      return null;
  }
}

// "left for" is load-bearing (auto-submit gate REVIEW_FLAG), same as the other two builders. Two
// distinct reasons, because they are two distinct user actions: we have no value to fill vs. we
// have one but the picker would not take it and a human must select the option.
export function locationSkipReason(field: LocationQuestion['field'], label: string, reason: 'no-value' | 'no-option'): string {
  const detail =
    reason === 'no-value'
      ? `no ${field} in your profile`
      : `couldn't select it in this picker`;
  return `location question left for you (${detail}): "${label.slice(0, 60)}"`;
}

// The typeahead queries for an ASYNC location combobox, fullest first. Ashby's picker runs a
// network lookup on what was typed, and the query must be SPECIFIC enough for it to return
// anything: typing "Dubai" alone rendered NO listbox on the live Espa Labs form (2026-07-17),
// while "Dubai, United Arab Emirates" returned exactly the right option. So the first query is
// the stored unit widened with every LESS specific stored unit after it, comma-joined the way a
// human types a place. The bare unit follows as a fallback for pickers with preloaded options,
// which filter by containment and would find nothing containing the fuller string.
//
// Composed ONLY from stored profile values - no unit is ever invented, defaulted, or completed,
// and an unset primary unit returns [] so a caller cannot type a query for a value the profile
// does not hold. That is the same never-fabricate line the GPA rule (R-005) draws.
export function locationComboQueries(field: LocationQuestion['field'], ap: ApplicationProfile): string[] {
  const units =
    field === 'city'
      ? [ap.address_city, ap.address_state, ap.address_country]
      : field === 'state'
        ? [ap.address_state, ap.address_country]
        : [ap.address_country];
  if (!units[0]?.trim()) return [];
  const seen = new Set<string>();
  const parts = units
    .map((u) => u?.trim() ?? '')
    .filter((u) => {
      const key = u.toLowerCase();
      if (!u || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const fuller = parts.join(', ');
  return fuller === parts[0] ? [fuller] : [fuller, parts[0]];
}

// ─── Language proficiency (declared-list authority) ─────────────────────────
//
// Live phrasings this exists for (2026-07-17): ZURU's "This role involves working closely with
// our team in Mexico, so Spanish language skills are preferred but not essential. Are you
// comfortable communicating in Spanish in a professional setting?" (radio Yes/No), and the
// Enpal-style level selects "Wie gut sind deine Deutschkenntnisse?" / "German level" /
// "English level".
//
// RoleQuick answers these from EXACTLY ONE source: the languages the student DECLARED
// (ApplicationProfile.languages). Never the resume, never citizenship, never the JD - a language
// "inferred" from adjacent data is R-015's exact failure (JD keywords lifted onto a submitted
// resume as if they were hers) re-expressed as a spoken claim. The mis-fill asymmetry each arm
// below encodes:
//   - asked language IS declared: a clean Yes, or the fluent-tier level. NEVER "Native": fluent
//     is what she declared, native is a STRONGER claim she did not make (the same line eeoAnswer
//     draws - a near-miss option is a different statement, not a formatting variant).
//   - asked language is NOT declared: an honest No is fillable, but only review-flagged. The
//     declared list is authoritative for what she CAN claim, weaker as proof of what she cannot
//     (she may simply not have listed one), so every No is confirmed by the student before
//     submit - the review wording matches the auto-submit gate's REVIEW_FLAG, so the hold
//     engages while it waits.
//   - anything ambiguous (native-level asks, multi-language stems, Chinese vs Mandarin): flag,
//     never guess.
//   - declared list EMPTY: always-ask, every time. No default, no resume peek.
//
// REFUSAL PRECEDENCE (locationQuestion's ordering doctrine): work-eligibility, citizenship and
// EEO guards run FIRST at every call site, and languageQuestion re-checks them internally, so a
// regression in either ordering alone cannot let a language rule answer a legal question.
// "Authorized to work" phrasings routinely name countries whose ADJECTIVES are languages
// ("Spanish", "German"), which is exactly how a language classifier could re-open R-004.

// Curated vocabulary: label variant -> canonical name. Curated rather than open-ended on purpose:
// only a language RoleQuick can NAME can ever be matched against the declared list, so a language
// outside this table degrades to the existing unrecognized-question flags instead of a guess.
// Native names (Deutsch, Espanol, Francais, Italiano, ...) are included because the form may ask
// in its own language; diacritics are stripped by normalizeLanguageText before lookup, so one
// ASCII key covers both spellings.
const LANGUAGE_VOCABULARY: Record<string, string> = {
  english: 'english', englisch: 'english',
  spanish: 'spanish', espanol: 'spanish', spanisch: 'spanish', castellano: 'spanish',
  german: 'german', deutsch: 'german',
  french: 'french', francais: 'french', franzosisch: 'french',
  italian: 'italian', italiano: 'italian', italienisch: 'italian',
  portuguese: 'portuguese', portugues: 'portuguese',
  dutch: 'dutch', nederlands: 'dutch',
  hindi: 'hindi',
  urdu: 'urdu',
  arabic: 'arabic', arabisch: 'arabic',
  mandarin: 'mandarin',
  chinese: 'chinese',
  cantonese: 'cantonese',
  japanese: 'japanese', japanisch: 'japanese',
  korean: 'korean',
  russian: 'russian', russisch: 'russian',
  turkish: 'turkish', turkisch: 'turkish',
  polish: 'polish', polnisch: 'polish',
};

// clean() + lowercase + strip diacritics (and fold the German eszett), so "Español" matches the
// `espanol` key and an option spelled "Fließend" can be matched by a "fliessend" value. NFD
// splits a diacritic into base char + combining mark; the mark range is then removable.
function normalizeLanguageText(s: string): string {
  return clean(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss');
}

// Longest-first so the alternation cannot stop at a shorter variant that shares a prefix.
const LANG_ALT = Object.keys(LANGUAGE_VOCABULARY)
  .sort((a, b) => b.length - a.length)
  .join('|');
const LANG_WORD_RE = new RegExp(`\\b(${LANG_ALT})\\b`, 'g');
// German fuses the language name and "kenntnisse" into one word ("Deutschkenntnisse"), so \b
// never fires between them and LANG_WORD_RE cannot see the language inside the compound.
const LANG_KENNTNISSE_RE = new RegExp(`\\b(${LANG_ALT})[\\s-]*(?:sprach)?kenntnisse`, 'g');

// (b) level questions: "German level", "English level", "Wie gut sind deine Deutschkenntnisse?",
// "niveau de francais". Checked BEFORE the yes/no shape: a level question answered Yes/No is a
// non-answer, and several level phrasings ("what is your level of spoken German") also contain
// yes/no-shape verbs.
const LANG_LEVEL_SHAPE = new RegExp(
  `\\b(?:${LANG_ALT})\\s+(?:language\\s+)?(?:level|niveau)\\b` +
    `|\\b(?:level|niveau)\\s+(?:of|in|de)\\s+(?:\\w+\\s+){0,2}(?:${LANG_ALT})\\b` +
    `|\\b(?:${LANG_ALT})[\\s-]*(?:sprach)?kenntnisse` +
    // "How would you describe your German language skills?" (Enpal, live 2026-07-17) is a LEVEL
    // ask phrased without the word "level" - its radio options are CEFR bands. A describe/rate
    // stem only counts as a level shape when a skills/proficiency/ability/level tail follows the
    // language name; without that tail ("would you describe yourself as fluent in X") the yes/no
    // shape below keeps it, so the ZURU comfort phrasing cannot be re-routed here.
    `|\\b(?:describe|rate|assess|evaluate)\\b[^?.]*\\b(?:${LANG_ALT})\\b[^?.]*\\b(?:language\\s+)?(?:skills?|proficiency|ability|level)\\b`,
);

// (a) yes/no comfort/fluency questions naming a language: "comfortable communicating in X",
// "fluent in X", "X language skills", "proficiency in X", "speak X". The verb stems are bounded
// on the left and the language name on both sides, with a small word gap between them, so a
// label that merely CONTAINS a language name with no proficiency ask around it ("please polish
// this design", a Turkish-coffee perk blurb) does not classify.
const LANG_YESNO_SHAPE = new RegExp(
  `\\b(?:comfortabl\\w*|fluen\\w*|proficien\\w*|convers\\w*|communicat\\w*|speak\\w*|understand\\w*)\\s+(?:\\w+\\s+){0,4}(?:${LANG_ALT})\\b` +
    `|\\b(?:${LANG_ALT})\\s+(?:language\\s+)?(?:skills?|fluency|proficiency|speaker)\\b`,
);

// A native-level CLAIM, distinct from mere fluency. Used two ways: a yes/no "are you a native X
// speaker?" is never answered (declared fluency cannot prove native), and no level value below
// ever names a native tier, so a level select can never have Native committed.
const NATIVE_CLAIM = /\bnative\b|mother\s*tongue|muttersprach|bilingual/;

export interface LanguageQuestion {
  kind: 'yesno' | 'level';
  // Canonical vocabulary names, deduped, in order of appearance. Usually one; the ZURU label
  // names Spanish twice and must still resolve to one.
  languages: string[];
}

export function languageQuestion(label: string): LanguageQuestion | null {
  const l = normalizeLanguageText(label);
  if (!l) return null;
  // Refusals first, same shape as locationQuestion: a work-eligibility / EEO / never-fill label
  // can never be a language question, and citizenship gets the same guard because nationality
  // ADJECTIVES double as language names ("Spanish", "German") - a citizenship dropdown's label
  // must keep resolving through classifyField, never through a fluency rule.
  if (isRefusedQuestion(l)) return null;
  if (/citizen|nationalit/i.test(l)) return null;
  // "Preferred programming language" is a tooling question. The natural-language vocabulary
  // rarely appears in one, but "English" does show up in developer-tooling labels ("comments in
  // English"), so the veto is explicit rather than assumed.
  if (/\b(?:programming|coding|scripting|computer|software)\s+languages?\b/.test(l)) return null;
  // "How many languages do you speak?" asks for a COUNT, not a proficiency in a named language.
  if (/\bhow many\b[^?]*\blanguages?\b/.test(l)) return null;

  const kind = LANG_LEVEL_SHAPE.test(l) ? 'level' : LANG_YESNO_SHAPE.test(l) ? 'yesno' : null;
  if (!kind) return null;

  const languages: string[] = [];
  for (const re of [LANG_WORD_RE, LANG_KENNTNISSE_RE]) {
    re.lastIndex = 0;
    for (let m = re.exec(l); m; m = re.exec(l)) {
      const canonical = LANGUAGE_VOCABULARY[m[1]];
      if (canonical && !languages.includes(canonical)) languages.push(canonical);
    }
  }
  return languages.length > 0 ? { kind, languages } : null;
}

// The student's declared list, canonicalized through the same vocabulary the questions resolve
// through, so "Deutsch" in the profile answers a "German" question. A declared language outside
// the vocabulary is kept as its normalized self: it can never match a question (questions only
// classify on vocabulary names), but it must not be silently dropped either.
function declaredLanguages(ap: ApplicationProfile): Set<string> {
  const out = new Set<string>();
  for (const raw of ap.languages ?? []) {
    const n = normalizeLanguageText(raw);
    if (n) out.add(LANGUAGE_VOCABULARY[n] ?? n);
  }
  return out;
}

// Chinese needs a curated asymmetry: a declared Mandarin or Cantonese speaker DOES speak
// "Chinese" (answering Yes is honest), but a declared "Chinese" asked specifically about
// Mandarin or Cantonese is ambiguous - the list does not say WHICH - so that direction is
// flagged, never guessed.
const CHINESE_FAMILY = ['chinese', 'mandarin', 'cantonese'];

function languageMembership(lang: string, declared: Set<string>): 'declared' | 'not-declared' | 'ambiguous' {
  if (declared.has(lang)) return 'declared';
  if (lang === 'chinese' && CHINESE_FAMILY.some((f) => declared.has(f))) return 'declared';
  if (CHINESE_FAMILY.includes(lang) && CHINESE_FAMILY.some((f) => declared.has(f))) return 'ambiguous';
  return 'not-declared';
}

// The level options RoleQuick may commit for a DECLARED language, fullest-claim-first, matched
// through matchOption's oneof (first value landing an unambiguous option wins). Deliberately no
// native tier - see NATIVE_CLAIM. C1 before C2 on the same conservatism: both are fluent-tier,
// C2 is the stronger claim, so it is only reached when the form offers no C1. German option
// spellings included for the Enpal-style boards (both eszett and ss forms: option TEXT is not
// normalized by matchOption, only the label was).
export const FLUENT_LEVEL_OPTIONS = [
  'fluent', 'proficient', 'c1', 'c2', 'advanced', 'full professional',
  'fliessend', 'fließend', 'verhandlungssicher',
];

// The lowest HONEST options for a language not on the declared list: only wordings that clearly
// mean none/basic. "Beginner"/"Elementary" are deliberately absent - they claim a little actual
// skill, and the declared list says nothing about a little. If none of these exists on the form,
// the field is left for the student (flagged), never rounded up.
export const NO_KNOWLEDGE_LEVEL_OPTIONS = [
  'none', 'no knowledge', 'not at all', 'keine kenntnisse', 'keine', 'a1', 'grundkenntnisse', 'basic',
];

// "left for" is load-bearing (auto-submit gate REVIEW_FLAG), same as the location/link builders.
export function languageSkipReason(label: string, why: string): string {
  return `language question left for you (${why}): "${label.slice(0, 60)}"`;
}

// Filled-but-flagged reasons for the not-declared arm. "review before submitting" is what the
// auto-submit gate's REVIEW_FLAG matches, so a filled No still HOLDS the countdown.
export function languageNoReviewReason(language: string, label: string): string {
  return `answered No (${language} is not in your declared languages), review before submitting: "${label.slice(0, 60)}"`;
}
export function languageLevelReviewReason(language: string, label: string): string {
  return `picked the lowest ${language} level (not in your declared languages), review before submitting: "${label.slice(0, 60)}"`;
}

// What an adapter should DO with a language question: fill this Desired (optionally pushing a
// review reason alongside), or flag it. null when the label is not a language question at all.
// Like linkQuestion/locationQuestion, classification never depends on what is stored - an empty
// declared list still terminates the block (flagged), it does not fall through to the drafter.
export type LanguageAnswerPlan =
  | { kind: 'fill'; desired: NonNullable<Desired>; reviewReason?: string }
  | { kind: 'skip'; reason: string };

export function languageAnswerPlan(label: string, ap: ApplicationProfile): LanguageAnswerPlan | null {
  const q = languageQuestion(label);
  if (!q) return null;
  const declared = declaredLanguages(ap);
  if (declared.size === 0) {
    return { kind: 'skip', reason: languageSkipReason(label, 'no languages declared in your profile') };
  }
  const l = normalizeLanguageText(label);

  if (q.kind === 'yesno') {
    // "Are you a native X speaker?" asks for a claim the declared list cannot prove in either
    // direction (she may or may not be native in a declared language) - always-ask.
    if (NATIVE_CLAIM.test(l)) {
      return { kind: 'skip', reason: languageSkipReason(label, 'asks about native-level ability') };
    }
    const memberships = q.languages.map((lang) => languageMembership(lang, declared));
    // Every named language declared -> a clean Yes ("do you speak English and French?" holds for
    // both "and" and "or" readings, so multi-language is safe only on this arm).
    if (memberships.every((m) => m === 'declared')) return { kind: 'fill', desired: { mode: 'yes' } };
    // Exactly one language asked and it is not declared -> an honest No, review-flagged.
    if (q.languages.length === 1 && memberships[0] === 'not-declared') {
      return { kind: 'fill', desired: { mode: 'no' }, reviewReason: languageNoReviewReason(q.languages[0], label) };
    }
    // Mixed multi-language stems ("and" vs "or" changes the honest answer) and the Chinese
    // ambiguity both land here: flag, never guess.
    return { kind: 'skip', reason: languageSkipReason(label, 'could not resolve it from your declared languages') };
  }

  // Level questions name exactly one language or nobody answers them.
  if (q.languages.length !== 1) {
    return { kind: 'skip', reason: languageSkipReason(label, 'names more than one language') };
  }
  switch (languageMembership(q.languages[0], declared)) {
    case 'declared':
      return { kind: 'fill', desired: { mode: 'oneof', values: [...FLUENT_LEVEL_OPTIONS] } };
    case 'not-declared':
      return {
        kind: 'fill',
        desired: { mode: 'oneof', values: [...NO_KNOWLEDGE_LEVEL_OPTIONS] },
        reviewReason: languageLevelReviewReason(q.languages[0], label),
      };
    default:
      return { kind: 'skip', reason: languageSkipReason(label, 'could not resolve it from your declared languages') };
  }
}

// The essay drafter must never be handed a question it cannot answer. This is the second half of
// R-006 (live QA 2026-07-16: a required "Why Abound?" left undrafted while "Why Cohere?" drafted
// fine on another Ashby form), and the whole chain is worth stating, because every link failed
// quietly:
//   labelTextFor returned "" (an existing-but-empty <legend> short-circuited the fall-through)
//     -> desiredAnswer("") matched no rule, so the block fell through to the drafter
//       -> the drafter was asked to answer ""
//         -> the backend rejects it outright (question: z.string().min(1) -> 400)
//           -> drafted = null -> a REQUIRED essay left blank.
// The label fall-through is fixed at the source (shared/dom.ts firstNonEmptyText). This guard is
// the backstop for any OTHER way a label can come back unreadable: never spend a round trip on a
// question we cannot state, and flag it so the student is told in the card instead of meeting an
// empty required essay at submit.
// 3 chars, because no real question is shorter and the cost of being wrong is asymmetric: flagging
// a legitimate question merely asks for a human, while drafting an unreadable one burns a metered
// LLM call to answer nothing.
const MIN_DRAFTABLE_QUESTION_CHARS = 3;

export function isDraftableQuestion(label: string): boolean {
  return label.trim().length >= MIN_DRAFTABLE_QUESTION_CHARS;
}

// "left for" again: an essay we declined to draft must hold auto-submit, not sail through blank.
export function unreadableQuestionSkipReason(): string {
  return "open-ended question left for you: Litos could not read this question's label";
}

// ─── Open-ended question shape (R-033) ──────────────────────────────────────
// The essay drafter's reach used to be textarea-shaped, but Greenhouse lets an author render a
// free-text question as a single-line input[type=text] - Gemini asked for "3-5 sentences" in a
// 255-char input, and the question was silently never drafted. Widening the drafter to every
// text input would be its own bug (every name field becomes an essay), so the gate keys on the
// QUESTION, not the control: does the label read like a prompt for prose? Callers must ALSO
// check that the label maps to no profile field and no refused question before drafting -
// this predicate only answers "is this asking for sentences", nothing about whether we should.
export function isOpenEndedQuestion(label: string): boolean {
  const l = clean(label ?? '').toLowerCase();
  if (!l) return false;
  // Essay-ish verbs and asks. Stems (describ\w+, explain\w*) rather than \b-bounded whole words,
  // because "explaining"/"describing" are how the live Gemini label was phrased and a boundary
  // after "explain" misses them.
  // "include a brief note on the type of problems you most enjoy working on" is the live Cresta
  // SWE Intern label (2026-07-17): no verb from the list below, no question mark, and a required
  // 255-char input left undrafted. "brief note" and "you (most) enjoy" are prose asks the way
  // "describe" is - a field label names a field, it does not invite a note about enjoyment.
  if (
    /\b(why\b|describ\w+|explain\w*|tell (?:us|me)\b|share\b|elaborat\w+|discuss\b|sentences?\b|paragraphs?\b|in your own words|what interest\w*|what excit\w*|what motivat\w*|what makes\b|how (?:did|do|would|have) you|brief note\b|note on\b|you (?:most )?enjoy\b)/.test(l)
  )
    return true;
  // A long interrogative label is a question being asked, not a field being named. Short
  // interrogatives without the verbs above ("Preferred name?") stay out on purpose.
  return l.includes('?') && l.length >= 40;
}

/**
 * Fit a drafted answer into a control's character budget WITHOUT misrepresenting the student.
 * Returns the largest whole-sentence prefix that fits, or null when no real sentence does - and
 * null must mean "leave it blank and flag it", never "clip mid-word". A sentence that ends
 * mid-clause is the R-029 family: text in her voice saying something she didn't. The sentence
 * boundary is a terminator FOLLOWED by space-or-end, so "3.89 GPA" and "web3.0" can't be cut at
 * their decimal points.
 */
export function fitToBudget(text: string, maxLen: number): string | null {
  const t = text.trim();
  if (maxLen <= 0 || t.length <= maxLen) return t || null;
  const slice = t.slice(0, maxLen);
  let lastEnd = -1;
  const re = /[.!?](?=\s|$)/g;
  for (let m = re.exec(slice); m; m = re.exec(slice)) lastEnd = m.index;
  // Under ~40 chars the "sentence" is almost certainly a fragment of the first clause, not an
  // answer; a blank flagged for the student beats a confident non-answer.
  if (lastEnd < 40) return null;
  return slice.slice(0, lastEnd + 1).trim();
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

  // Everything below is a profile-field lookup, so the FIELD IDENTITY now comes from
  // classifyField - the same classifier harvest reads with. Two copies of these regexes would
  // drift, and the drift would be invisible: RoleQuick would fill one field and learn a different
  // one. From here desiredAnswer's only job is shaping a stored value for the option matcher.
  //
  // Only the keys that were already answered here are handled. classifyField recognises more
  // (phone, links, gpa, major), but those are filled by the identity-first chain in
  // fillGenericApplication, and returning them here would start answering selects/radios that
  // previously fell through. `default: null` keeps that behaviour exactly as it was - EXCEPT for
  // address_state/address_city, which now answer deliberately (R-002): a location question
  // rendered as a select/radio/combobox previously fell through and was left silently blank, and
  // three of twelve live forms bounced at submit on exactly that.
  switch (classifyField(l)) {
    // Citizenship is often stored as a nationality adjective ("Indian") while a country dropdown
    // lists the country ("India"), and a combobox typeahead filters by what is typed - so map the
    // adjective up front; oneof still lets a plain-text or exact-country field take the raw value.
    // Unset citizenship leaves the field BLANK rather than guessing: classifyField already routed
    // this away from address_country, so a student whose citizenship differs from where they live
    // can never have residence answered into a citizenship question.
    case 'citizenship': {
      if (!ap.citizenship) return null;
      const c = ap.citizenship.trim().toLowerCase();
      const country = NATIONALITY_TO_COUNTRY[c];
      return country
        ? { mode: 'oneof', values: [country, ap.citizenship] }
        : { mode: 'value', value: ap.citizenship };
    }

    // Where the student LIVES, not their nationality. "Which country do you intend to work from"
    // asks about location; the two differ and the split lives in classifyField now. These three
    // cases mirror locationQuestion exactly (both funnel through classifyField for identity), so
    // an adapter that resolves the question via locationQuestion and one that resolves it here
    // cannot disagree on which stored value answers it. Only a RESOLVED value answers; an unset
    // field returns null and falls through. Adapters that call locationQuestion directly get the
    // stronger guarantee - an unset value is flagged rather than left silently blank (R-002).
    case 'address_country':
      return ap.address_country ? { mode: 'value', value: ap.address_country } : null;
    case 'address_state':
      return ap.address_state ? { mode: 'value', value: ap.address_state } : null;
    case 'address_city':
      return ap.address_city ? { mode: 'value', value: ap.address_city } : null;

    // The option set varies wildly per form (LinkedIn, Company website, Job board, Other, ...), so
    // a single value rarely matches. Try the student's own answer, then near-synonyms, then
    // "Other" as the safe catch-all. No value guard: the fallbacks stand on their own.
    case 'referral_source_default':
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

    // Salary answers route through the R-031 rule rather than the bare stored value: a range
    // stated in the label fills its MEDIAN (currency-safe by construction), a stored prose answer
    // passes through, and a stored bare figure fills ONLY when the label names a currency that
    // matches desired_salary_currency. Everything else returns null so the caller's own skip
    // reason ("dropdown left for you" / "no matching control, left blank") holds auto-submit.
    // The old body here - `ap.desired_salary ? { mode: 'value', value: ap.desired_salary } : null`
    // - is R-031's exact defect: a bare figure replayed into any posting, in any currency.
    // Free-text salary controls in this adapter and Ashby are intercepted before ever reaching
    // this case (they carry control-shape and posting context this signature cannot); what lands
    // here is choice controls (select/radio/combobox) and the other ATS adapters' known path,
    // whose value sinks are text-only (input[type="text"|"url"|"tel"]), so prose can never reach
    // a numeric control through this return.
    case 'desired_salary': {
      const salary = resolveSalary({ label: l, field: 'freetext' }, storedSalaryOf(ap));
      return salary.action === 'fill' ? { mode: 'value', value: salary.value } : null;
    }
    case 'date_of_birth':
      return ap.date_of_birth ? { mode: 'value', value: ap.date_of_birth } : null;

    // HOW LONG, not when (R-014). classifyField checks TERM_QUESTION before START_DATE_QUESTION
    // for the same reason the if-chain did: both phrasings contain "availab", and answering a
    // duration question with a start date is exactly what shipped on a live Espa form.
    case 'availability_term':
      return ap.availability_term ? { mode: 'value', value: ap.availability_term } : null;
    case 'availability_date':
      return ap.availability_date ? { mode: 'value', value: ap.availability_date } : null;

    default:
      return null;
  }
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

  // Page text for the salary rule's JD sources (a stated range, or a currency, adjacent to
  // salary wording), read lazily once per fill: the generic adapter runs on a company's own
  // careers page, where the JD and the form share the document.
  let jdTextCache: string | null = null;
  const jdText = () => (jdTextCache ??= extractGenericJdText());

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

    // Salary (R-031 + R-011), before the generic value lookup: this branch owns free-text,
    // numeric AND textarea salary controls, because the decision needs the control's shape (a
    // prose answer must never enter a number box) and the page text (the posting's stated range
    // beats anything stored). Combobox-rendered salary stays on the combobox path below, which
    // resolves through desiredAnswer and lands on the same salary rule. Before this branch, the
    // value lookup below typed the bare stored figure into free-text and type=number salary
    // fields with no currency check (R-031's exact defect), and a salary textarea fell through
    // to the AI essay drafter - a drafted negotiating anchor in the student's name.
    if (value === undefined && !isComboboxControl(el) && classifyField(id) === 'desired_salary') {
      const numeric = type === 'number' || /^(numeric|decimal)$/i.test(el.getAttribute('inputmode') ?? '');
      const salary = resolveSalary(
        { label: questionLabel(el) || id, field: numeric ? 'numeric' : 'freetext', jdText: jdText() },
        storedSalaryOf(ap),
      );
      if (salary.action === 'fill') {
        await fillTextField(el, salary.value);
        fields_filled++;
      } else {
        fields_skipped++;
        skipped_reasons.push(salary.reason);
      }
      continue;
    }

    // Profile-value questions that can appear as free-text (DOB, citizenship, etc.; salary is
    // owned by the branch above).
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
      // Language questions first (declared-list authority): a level question routinely renders
      // as a react-select. languageAnswerPlan re-checks the refusal guards internally, so running
      // it ahead of desiredAnswer cannot answer a work-eligibility or EEO label.
      const langLabel = questionLabel(el) || id;
      const langPlan = languageAnswerPlan(langLabel, ap);
      if (langPlan) {
        if (langPlan.kind === 'skip') {
          fields_skipped++;
          skipped_reasons.push(langPlan.reason);
          continue;
        }
        if ((await fillComboboxFor(el as HTMLElement, langPlan.desired)) === 'filled') {
          fields_filled++;
          if (langPlan.reviewReason) {
            skipped_reasons.push(langPlan.reviewReason);
            markForReview(el, 'Language answer: review before submitting');
          }
        } else {
          fields_skipped++;
          skipped_reasons.push(languageSkipReason(langLabel, 'no honest option in this picker'));
        }
        continue;
      }
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
      const question = questionLabel(el) || id;
      // A language question rendered as free text never reaches the drafter either: the model
      // knows nothing about the declared list, and a drafted paragraph claiming comfort in a
      // language she never declared is a fabricated claim in her voice (R-015's shape). The
      // "left for" flag holds auto-submit instead.
      if (languageQuestion(question)) {
        fields_skipped++;
        skipped_reasons.push(languageSkipReason(question, 'needs your own answer, not a draft'));
        continue;
      }
      if (draftAnswer) {
        pendingDrafts.push({ el, question });
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
    const options = [...select.options]
      .filter((o) => o.value && !/^(select|choose|please|--)/i.test(o.text.trim()))
      .map((o) => ({ text: o.text, value: o.value }));
    // Language questions first (declared-list authority): the Enpal-style "German level" /
    // "English level" selects land here. languageAnswerPlan re-checks the refusal guards
    // internally, so running it ahead of desiredAnswer cannot answer a work-eligibility or EEO
    // label. Always terminates the select: fill or flag, never silence.
    const langPlan = languageAnswerPlan(label, ap);
    if (langPlan) {
      if (langPlan.kind === 'skip') {
        fields_skipped++;
        skipped_reasons.push(langPlan.reason);
        continue;
      }
      const m = matchOption(options, langPlan.desired);
      if (m) {
        await randomDelay();
        setNativeValue(select, m.value);
        fields_filled++;
        if (langPlan.reviewReason) {
          skipped_reasons.push(langPlan.reviewReason);
          markForReview(select, 'Language answer: review before submitting');
        }
      } else {
        fields_skipped++;
        skipped_reasons.push(languageSkipReason(label, 'no honest option to select'));
      }
      continue;
    }
    const desired = desiredAnswer(label, ap, eeo);
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
    // Language questions first (declared-list authority): ZURU's "comfortable communicating in
    // Spanish?" is a radio Yes/No. Refusal guards are re-checked inside languageAnswerPlan, so
    // this ordering cannot answer a work-eligibility or EEO label. Always terminates the group.
    const langPlan = languageAnswerPlan(label, ap);
    if (langPlan) {
      if (langPlan.kind === 'skip') {
        fields_skipped++;
        skipped_reasons.push(langPlan.reason);
        continue;
      }
      const m = matchOption(options, langPlan.desired);
      if (m) {
        await randomDelay();
        checkChoice(m.el);
        fields_filled++;
        if (langPlan.reviewReason) {
          skipped_reasons.push(langPlan.reviewReason);
          markForReview(visibleLabelFor(m.el) ?? m.el, 'Language answer: review before submitting');
        }
      } else {
        fields_skipped++;
        skipped_reasons.push(languageSkipReason(label, 'no honest option to select'));
      }
      continue;
    }
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
    // A single "I am fluent in X" attestation checkbox: tick only on a clean in-list Yes. For
    // every other language outcome the honest state IS unticked, but the student is still told
    // (flag), because a silently unticked attestation is invisible on the card.
    const langPlan = isAgreement ? null : languageAnswerPlan(id, ap);
    if (langPlan) {
      if (langPlan.kind === 'fill' && langPlan.desired.mode === 'yes') {
        await randomDelay();
        checkChoice(cb);
        fields_filled++;
      } else {
        fields_skipped++;
        skipped_reasons.push(
          langPlan.kind === 'skip' ? langPlan.reason : languageSkipReason(id, 'not in your declared languages'),
        );
      }
      continue;
    }
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

  // Documents this form requires that RoleQuick cannot produce (R-010). Reported at fill time, in
  // the card, so the student learns the form wants a transcript NOW rather than at submit; the
  // "left for" wording holds auto-submit while it sits unattached.
  const documentReasons = unattachableDocumentReasons();
  fields_skipped += documentReasons.length;
  skipped_reasons.push(...documentReasons);

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
// `note` exists because not everything flagged for review is an AI draft. A converted
// grade (R-005) is a deterministic band mapping, not model output, and calling it an "AI
// draft" would tell the student an LLM invented their GPA.
function markForReview(el: HTMLElement, note = '✎ AI draft: review before submitting') {
  el.style.outline = '2px solid #f59e0b';
  el.style.outlineOffset = '1px';
  const badge = document.createElement('div');
  badge.textContent = note;
  badge.style.cssText =
    'font:600 11px -apple-system,BlinkMacSystemFont,sans-serif;color:#b45309;margin-top:4px;';
  el.insertAdjacentElement('afterend', badge);
}
