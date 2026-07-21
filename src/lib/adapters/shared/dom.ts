// Shared DOM primitives for the ATS adapters. Historically each adapter re-declared these, so a
// fix made in one silently missed the others - the radio-commit registration bug (below) is the
// canonical example: only the LinkedIn adapter dispatched a click, so React-controlled radios on
// Greenhouse / Lever / Ashby / Workday flipped visually but never committed to framework state
// and were lost on submit. Keep the single source of truth here.

// Select a radio or check a checkbox the way a real user does: input.click() natively sets
// .checked and fires click, input, and change together. Controlled React groups commonly update
// their state from the click (or from change fired as a consequence of a trusted click), and
// ignore a synthetic change dispatched on a hidden input whose .checked was poked directly - so
// `.checked = true` + dispatch('change') alone updates the DOM but not the component, and the
// selection reverts on submit. The fallback covers the rare widget that preventDefaults the
// programmatic click.
export function commitChoice(el: HTMLInputElement): void {
  el.click();
  if (!el.checked) {
    el.checked = true;
    el.dispatchEvent(new Event('click', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// Pick the first candidate with real text, lowercased for the label matchers. Trivial-looking, and
// it exists for a specific reason: `??` does NOT do this. An element that EXISTS but renders no
// text yields "", which is non-null, so `a?.textContent ?? b?.textContent` returns the empty string
// and never reaches the fallback. radioOptionsIn already carries this warning ("`||` not `??`") -
// it was the canonical radio non-fill - but the same bug outlived that fix in the adapters' own
// question-label readers, which is R-006: an entry whose <legend> exists but is empty resolved the
// whole question to "". An empty question is not a harmless miss. It makes every classifier miss
// (work-eligibility, EEO, location all key off this string), and it reaches the essay drafter as
// `question: ""`, which the backend rejects outright (z.string().min(1) -> 400), so the draft comes
// back null and a REQUIRED essay is left blank. That is exactly "Why Abound?" going undrafted on
// one Ashby form while "Why Cohere?" drafted fine on another (live QA 2026-07-16).
export function firstNonEmptyText(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const text = candidate?.replace(/\s+/g, ' ').trim();
    if (text) return text.toLowerCase();
  }
  return '';
}

// Fields we never fill regardless of what the form asks, matched against a control's label text.
// (generic.ts keeps its own shorter NEVER_FILL_PATTERNS keyed on the control identity string;
// the ATS adapters all shared this label-based list verbatim.)
export const NEVER_FILL_LABEL_PATTERNS = [/social security/i, /ssn\b/i, /driver'?s?\s*licen[sc]e/i, /background check consent/i];

// Human-like pacing between field writes, so a fill doesn't look like an instant script dump.
export function randomDelay(minMs = 120, maxMs = 380): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Write a value through the native setter and fire input+change, so React/Vue controlled inputs
// see it as a real edit rather than a value poke they'll overwrite on next render. Selects are
// included (R-032's phone country selector is one): a React-controlled <select> ignores a bare
// `.value =` for the same reason a controlled input does.
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype :
    HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export async function fillField(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  canWrite: () => boolean = () => true,
): Promise<boolean> {
  await randomDelay();
  if (!canWrite()) return false;
  el.focus();
  setNativeValue(el, value);
  el.blur();
  return true;
}

// ─── Verify-after-fill (R-032) ────────────────────────────────────────────────
//
// setNativeValue is the CORRECT write for a mounted React input (R-007's closure proved it live,
// twelve submissions running). What it cannot survive is being run BEFORE React hydrates: the
// write lands on the server-rendered DOM, no component is listening yet, and hydration then
// replaces the value with the component's own (empty) state. That is R-032's signature on
// job-boards.greenhouse.io - the card said "Filled 5 fields" while First/Last/Email were empty,
// because the adapter counted its write, not the DOM's eventual state.
//
// So a write is only trusted once it demonstrably PERSISTS, and the check is a detection loop,
// not a fixed sleep. The loop reads the value back on a widening schedule and distinguishes
// three worlds:
//   - the framework has adopted the node (React stamps a `__reactFiber$...` expando on every
//     host element it manages, and a `_valueTracker` on controlled inputs, at hydration/render
//     time): a value that survives one read-back HERE is committed - exit immediately;
//   - no framework signal and the caller doesn't expect one (legacy boards.greenhouse.io is
//     plain server HTML): a value that sits still through a few consecutive reads is real - exit
//     after a short stability streak instead of burning the whole window;
//   - the value was REVERTED (typically to empty, by hydration): re-fill it - the re-fill runs
//     against the now-mounted component, which is exactly the write R-007 proved correct - and
//     keep watching. Re-fills are bounded so a widget that fights every write can't loop us.

// Has a framework (React) attached itself to this node? Pre-hydration server HTML has neither
// expando; post-hydration React host nodes always carry the fiber key, and controlled inputs
// additionally carry _valueTracker.
export function isReactManagedNode(el: Element): boolean {
  const bag = el as unknown as Record<string, unknown>;
  if ('_valueTracker' in bag) return true;
  for (const k of Object.keys(bag)) {
    if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return true;
  }
  return false;
}

export interface VerifyPersistOptions {
  // Read-back schedule. The default widens from quick checks (catch an immediate revert cheaply)
  // to slower ones (cover a hydration that lands a few seconds after the fill). The sum is the
  // whole window's bound, ~5s - there is no path that waits longer.
  delaysMs?: number[];
  // How many times a reverted-to-empty field is re-filled before giving up and reporting false.
  maxRefills?: number;
  // True on a board known to hydrate (job-boards.greenhouse.io): the early stability exit is
  // disabled, because pre-hydration a value "sits still" right up until hydration wipes it, so
  // stillness proves nothing there. Only the framework signal (or surviving the full window)
  // counts. False for plain-HTML boards, where three quiet reads is real persistence.
  expectHydration?: boolean;
}

// Compare what the field holds against what was written. Whitespace is not a revert; and for tel
// inputs the comparison is digits-only, because phone widgets legitimately re-space a number -
// "56 741 7451" for "567417451" is the same value, while intl-tel-input's trunk-zero rewrite
// ("0567417451") changes the digits and is exactly the mangle R-032 must flag.
function holdsValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (norm(el.value) === norm(value)) return true;
  if ((el as HTMLInputElement).type === 'tel') {
    const digits = (s: string) => s.replace(/\D/g, '');
    return digits(el.value) === digits(value) && digits(value).length > 0;
  }
  return false;
}

// Watch a just-filled field until its value verifiably persists (true) or demonstrably will not
// (false). Only an EMPTY field is ever re-filled: a different non-empty value means either the
// student started typing (never fight them) or a widget rewrote the value (that rewrite is what
// R-032's phone mangle looks like, so surface it for review instead of thrashing).
export async function verifyFieldPersists(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  opts: VerifyPersistOptions = {},
): Promise<boolean> {
  const delays = opts.delaysMs ?? [150, 350, 700, 1400, 2500];
  const maxRefills = opts.maxRefills ?? 3;
  let refills = 0;
  let stable = 0;
  for (const d of delays) {
    await pause(d);
    if (holdsValue(el, value)) {
      stable++;
      if (isReactManagedNode(el)) return true; // framework adopted it; committed
      if (!opts.expectHydration && stable >= 3) return true; // plain form, value sat still
      continue;
    }
    if (el.value.trim() !== '') return false; // rewritten, not wiped: hands off, flag it
    if (refills >= maxRefills) return false;
    refills++;
    stable = 0;
    await fillField(el, value); // hydration wiped it; this write hits the mounted component
  }
  // Window exhausted with no framework signal either way: trust the last read. This is the
  // "count only what persists at count time" contract - a hydration slower than the whole
  // window escapes it, but that bound is explicit rather than a hopeful sleep.
  return holdsValue(el, value);
}

export function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

// ATS labels are author-written, so a phone field is not reliably labelled "Phone". Live-caught
// 2026-07-17 (R-020): Enpal's Ashby board labels its REQUIRED phone field just "Number", which
// `/\bphone\b/` misses, so the field came back empty on a form where the profile HAD the number.
// That is the worst class of non-fill - not "we lack the data" but "we had it and missed".
//
// This matcher took four attempts. Each earlier one fixed its own bug and created the opposite one,
// so the ORDER of the rules below is the design, not an accident:
//
//   0. Third-party veto, ahead of everything. Not her number, whatever else the label says.
//   1. An unambiguous phone word, on any control type (plenty of boards use `type="text"`).
//   2. The control's own `autocomplete`, the only attribute with spec-defined phone semantics.
//   3. A number word on a tel control, with an ALLOWLISTED qualifier next to it. Default deny.
//
// Rule 3 is default-deny because the failure modes are not symmetric: a missed phone label is a
// blank box the student fills in (recoverable), while a wrong match types her phone number into
// someone else's field (not). Both a substring match and a denylist were tried and both leaked the
// bad direction: a denylist of "what the number is for" cannot enumerate the world's ID systems, so
// "National Insurance number", "Emirates ID number", "Aadhaar number" and "Fax number" all sailed
// through into her phone number.

// Rule 0. Beats every tier: these ask for someone else's number, so a phone word in the label is a
// reason to REFUSE, not to fill. "Emergency contact phone" and "Reference's phone number" both
// matched rule 1 and got hers.
//
// This veto must speak every language rule 1 does, or it is not a veto. Rule 1's vocabulary was
// widened to German on purpose (telefon(?:nummer|nr)?, handy(?:nummer)?, mobil(?:e|nummer)?) for
// Enpal, the German board R-014 and R-020 both came from - and while rule 0 stayed English-only,
// "Telefonnummer des Notfallkontakts" sailed past it and took her personal number, on exactly the
// board the German support exists for. The English twin was already forbidden by test. A veto that
// refuses in one language and fills in another is worse than no veto, because it reads as covered.
//
// The German alternatives are matched WITHOUT \b, for the same reason rule 1 spells out its
// suffixes: a German compound has no interior word boundary, so \bnotfall\b cannot match inside
// "Notfallkontakts". Over-refusing here is cheap and deliberate - "Referenznummer" (an application
// reference number) is not her phone either, and rule 0's whole job is to prefer a blank box over
// someone else's field.
const THIRD_PARTY_RE =
  /\b(reference|references|referee|referees|emergency|guardian|next of kin|kin)\b|notfall|referenz|erziehungsberechtigt|angeh(?:ö|oe)rig|vormund/i;

// Rule 1. `tel` is deliberately NOT here: it lived here for one commit and matched "Preferred
// office: Tel Aviv or Berlin" on a plain text field. It survives in rule 3's qualifier list, where
// the tel-control gate and the adjacent number word keep it honest.
//
// The optional German suffixes are load-bearing: `\btelefon\b` cannot match inside "Telefonnummer"
// because a compound has no interior word boundary, so the standard German phone label was missed
// outright - on Enpal, the German board R-020 came from. The trailing \b still rejects "Mobility"
// and "Handyman", which is why the suffixes are spelled out rather than the boundary dropped.
const PHONE_LABEL_RE =
  /\b(phone|telephone|telnr|telefon(?:nummer|nr)?|mobil(?:e|nummer)?|cell(?:phone)?|handy(?:nummer)?)\b/i;

// Rule 2. Tested per TOKEN, because autocomplete is a token list, not a value: the grammar is
// `[section-*] [shipping|billing] [home|work|mobile|fax|pager] tel`, so `autocomplete="home tel"`
// is the canonical way to mark a home phone and `"shipping tel"` is legal too. `name`/`id` were
// tried here and dropped: they are author prose in an attribute, so a stray "mobile" in an id spoke
// over the label entirely.
const PHONE_AUTOCOMPLETE_TOKEN_RE = /^tel(-|$)/i;

function declaresPhoneAutocomplete(value: string): boolean {
  return value.trim().split(/\s+/).some((token) => PHONE_AUTOCOMPLETE_TOKEN_RE.test(token));
}

// Rule 3. The number word, and the qualifiers allowed to sit beside it.
//
// ADJACENCY is what makes an allowlist work. A bag-of-words allowlist leaks the bad direction just
// like the denylist did: "Number of hours you can work per week" contains "work", and "work" is a
// perfectly good phone qualifier - but only when it is touching the number word. "Work number"
// fills; "Number of hours you can work" does not, because the token next to "number" is "of".
// `nr` is deliberately NOT here, though `number` and `nummer` are. German address forms split the
// street into `Straße` and `Nr.`, and a house-number box is exactly the numeric-keypad field that
// gets `type="tel"` - so a bare `Nr.` on a tel control would take her phone number as her house
// number, on Enpal, the German board BOTH R-014 and R-020 came from. `nr` was not in the original
// matcher (`number|nummer|tel|no`); it was added during this work and is now walked back.
const NUMBER_WORDS = new Set(['number', 'nummer']);
// Tokens a label can be made ENTIRELY of and still just mean "your number": "Tel", "Tel No",
// "Tel. Nr", "Nummer". Wider than NUMBER_WORDS, because a token can be part of a bare phone label
// without being evidence of one on its own - a lone "No" or "Nr." means nothing, while "Tel Nr"
// plainly does. Hence the second condition below: something here must be a real number word or
// `tel` before any of this counts.
const BARE_PHONE_TOKENS = new Set([...NUMBER_WORDS, 'no', 'nr', 'tel', 'telefon']);
const PHONE_QUALIFIERS = new Set([
  'contact', 'best', 'primary', 'secondary', 'alternate', 'alternative', 'preferred', 'main',
  // `personal` is deliberately absent: "Personal number" is the standard English rendering of the
  // Nordic personnummer, the national identity number, and Swedish/Norwegian boards ask for it in
  // exactly those words. Losing "Personal number" as a phone label costs a blank box; keeping it
  // costs her phone number in a national-ID field. `private` carries no such collision.
  'private', 'your', 'my', 'work', 'home', 'daytime', 'evening', 'mobile', 'cell',
  'tel', 'telephone', 'phone', 'whatsapp', 'sms', 'landline',
]);
// A label can also earn it by saying what the number is used FOR, when that use is contacting her.
const PHONE_PURPOSE_RE = /\b(reach|call|contact|text|message)\s+(you|me)\b|\bschedule\b|\binterview/i;

// Strip decoration so the tokens are the words the author actually wrote. "Number *", "Number:",
// "Number ✱" and "Number (required)" are all the same label.
const DECORATION_RE = /\b(required|optional|mandatory)\b/gi;

function labelTokens(label: string): string[] {
  return label
    .toLowerCase()
    .replace(DECORATION_RE, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

// Is the number word in this label qualified as HERS, or is it some other number entirely?
function numberIsPhoneShaped(label: string): boolean {
  const tokens = labelTokens(label);
  if (tokens.length === 0) return false;

  // The whole label is number-ish and nothing else: "Number" (Enpal's real field), "Tel", "Tel No".
  // Requires a real number word or "tel" present, so a lone "No" does not qualify.
  if (tokens.every((t) => BARE_PHONE_TOKENS.has(t)) && tokens.some((t) => NUMBER_WORDS.has(t) || t === 'tel')) {
    return true;
  }

  const i = tokens.findIndex((t) => NUMBER_WORDS.has(t));
  if (i === -1) return false;
  // "Contact number", "Work number" - the qualifier must be TOUCHING the number word. "Number of
  // hours you can work per week" also contains "work", three tokens away, and is not her phone.
  if (i > 0 && PHONE_QUALIFIERS.has(tokens[i - 1])) return true;
  // Or the label says the number is for contacting her: "Number to reach you on", "Number we will
  // use to schedule interviews".
  return PHONE_PURPOSE_RE.test(tokens.join(' '));
}

// Rule 1's guard (R-028). A phone word is only evidence of a phone FIELD when the label is a field
// label at all. "Phone" is; "Have you contributed to a mobile app(s) and/or several features that
// reached a large number of users?" is a question that merely contains one - and rule 1, matching
// the word anywhere with no negative check, answered it with her phone number on Ramp, live.
//
// That is the R-018 harm class (a MIS-FILL), and strictly worse than the R-020 non-fill rule 1 was
// widened to fix: a blank box cannot lie. Rule 3 is default-deny for exactly this reason; rule 1
// was the one tier that was default-allow, which is the whole bug.
//
// The reasoning already existed one tier up and simply was not applied to the label. Rule 2's note
// explains that `name`/`id` were dropped because `id="mobile-2"` on "Do you own a mobile device?"
// "would have answered a yes/no question with her phone number". A label is author-chosen prose
// too. Ramp's label is that hypothetical, one word different.
//
// The signal is POSITION, not shape, and not vocabulary.
//
// A field label NAMES its field, and the name comes first: "Phone", "Mobile phone number",
// "Telefonnummer, unter der wir Sie erreichen koennen". Prose that merely mentions a phone word
// uses it as a modifier, buried: "a MOBILE app", "MOBILE development experience", "cell culture".
// So rule 1 asks where the phone word sits, not how long the label is or whether it ends in "?".
//
// Shape was tried first and was wrong in both directions. Rejecting labels over 40 chars killed
// "Mobile phone number where we can reach you during business hours" and the German
// "Telefonnummer, unter der wir Sie erreichen koennen" - a fresh R-020 non-fill on Enpal, the very
// board R-020 came from. Rejecting interrogative openers killed "Please provide your phone
// number", because `please` heads a request for a field, not a question about one. And stripping
// parentheticals before looking for "?" let "Mobile (Have you shipped one? ...)" back through, so
// the guard did not even hold the line it was built for. Position has none of those failure modes:
// it never measures prose, so prose cannot fool it.
//
// A denylist of nouns was never an option: the set of things that merely mention "mobile" (apps,
// devices, web, teams, experience, platforms) is unbounded, and rule 3's own comment records that
// a denylist "cannot enumerate the world's ID systems".

// Words that may precede a field's name without changing which field it is. A label is allowed to
// ask politely; that is what makes "Please provide your phone number" a phone field and
// "Please describe your mobile experience" not one - `describe` is not in here, so the head of
// that label is `describe`, not `mobile`.
const REQUEST_FILLERS = new Set([
  'please', 'kindly', 'enter', 'provide', 'add', 'give', 'share', 'include', 'input', 'type', 'fill',
  'your', 'my', 'the', 'a', 'an',
]);

// List numbering, so a numbered form keeps its head: "1. Phone number" is still a phone field,
// while "1. Do you own a mobile device" is still not one.
const LIST_MARKER_RE = /^q?\d+$/;

// Heads that already carry their own number word, so nothing needs to follow them. German compounds
// have no interior word boundary, which is why they are matched whole rather than tokenised.
const PHONE_NUMBER_COMPOUND_RE = /^(?:telefon|mobil|handy)nummer$|^telnr$/i;

function isPhoneHeaded(label: string): boolean {
  const tokens = labelTokens(label);
  let i = 0;
  while (i < tokens.length && (LIST_MARKER_RE.test(tokens[i]) || REQUEST_FILLERS.has(tokens[i]))) i++;
  const rest = tokens.slice(i);
  if (rest.length === 0) return false;

  // The field's name must lead. This single check is what rejects every question, with no list of
  // question words: "Have you contributed to a mobile app?" is headed by `have`, "Do you own a
  // mobile device" by `do`, "Which mobile platforms..." by `which`, "Years of mobile experience"
  // by `years`, "Link to your mobile app" by `link`.
  if (!PHONE_LABEL_RE.test(rest[0])) return false;

  // ...and having led, the label must not go on to be about something else.
  // (a) Nothing but phone vocabulary: "Phone", "Mobile", "Cell phone", "Mobile no".
  if (rest.every((t) => PHONE_LABEL_RE.test(t) || BARE_PHONE_TOKENS.has(t))) return true;
  // (b) The head is its own number word: "Telefonnummer, unter der wir Sie erreichen koennen".
  if (PHONE_NUMBER_COMPOUND_RE.test(rest[0])) return true;
  // (c) A run of phone words, then a number word: "Mobile phone number for interview scheduling".
  // This is what separates "Mobile phone number ..." from "Mobile app experience": both are headed
  // by `mobile`, and only one of them is followed by the word that makes it a number.
  let j = 0;
  while (j < rest.length && PHONE_LABEL_RE.test(rest[j])) j++;
  return j < rest.length && NUMBER_WORDS.has(rest[j]);
}

export function isPhoneLabel(label: string, el?: Element | null): boolean {
  if (THIRD_PARTY_RE.test(label)) return false;
  // Failing the head check is not a verdict of "not a phone", only "rule 1 does not get to decide".
  // The label still falls through to the autocomplete and type="tel" tiers, which are structural
  // rather than prose-based, so a real phone field wearing an unusual label degrades to a
  // recoverable non-fill instead of a mis-fill.
  if (isPhoneHeaded(label)) return true;
  const input = el as HTMLInputElement | null;
  if (!input) return false;
  if (declaresPhoneAutocomplete(input.getAttribute?.('autocomplete') ?? '')) return true;
  if (input.type !== 'tel') return false;
  return numberIsPhoneShaped(label);
}

// Radios that carry no meaningful `value` (Ashby/LinkedIn use "on"): the real option text lives
// in the associated `label[for=radio.id]`. Returns each radio paired with its label text.
export function radioOptionsIn(block: Element): Array<{ radio: HTMLInputElement; text: string }> {
  return [...block.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((radio) => {
    // `label[for=id]` only resolves when the radio has an id AND a separate <label for>. LinkedIn
    // (and some others) wrap the input in its label with no `for`, so also fall back to the
    // enclosing <label>, then aria-label, then the value. Without these fallbacks the option text
    // came back empty and no yes/no/EEO option ever matched - the canonical radio non-fill.
    const forLabel = radio.id ? document.querySelector(`label[for="${CSS.escape(radio.id)}"]`) : null;
    // `||` not `??`: an empty (but non-null) `label[for]` textContent must still fall through to
    // the wrapping label / aria-label / value rather than resolve to "".
    const text = (
      forLabel?.textContent ||
      radio.closest('label')?.textContent ||
      radio.getAttribute('aria-label') ||
      radio.value ||
      ''
    )
      .trim()
      .toLowerCase();
    return { radio, text };
  });
}

// Does this question block already carry an answer? The location branch (R-002) needs this because
// a block loop and an earlier selector-based pass can both reach the same field: Greenhouse fills
// #candidate-location before the loop runs, and that input sits inside a .field-wrapper the loop
// then visits. Without this guard the loop would re-open an already-answered combobox and, failing
// to re-select, flag a field that is in fact correctly filled.
// Covers the four shapes an answered control takes. The react-select case is the subtle one: its
// inner input keeps an EMPTY value after a selection (the chosen option renders as a separate
// singleValue node), so a value check alone reads an answered picker as blank.
export function blockAlreadyAnswered(block: Element): boolean {
  const text = block.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    'input[type="text"], input[type="tel"], input[type="url"], input[type="email"], textarea',
  );
  if (text?.value.trim()) return true;
  if (block.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked')) return true;
  const select = block.querySelector<HTMLSelectElement>('select');
  if (select?.value) return true;
  return !!block.querySelector('[class*="singleValue"], [class*="multiValue"]');
}

// ─── Documents Litos cannot attach (R-010) ───────────────────────────────
// Litos generates exactly ONE artifact: the tailored resume. A form that also demands a
// transcript, cover letter, or portfolio therefore cannot be finished, and the student has to take
// over. That limit is a product decision, not a bug. The BUG was that Litos said nothing about
// it: the card reported a successful fill, and the student met the empty required upload at submit.
//
// This is squarely the target market rather than an edge case - co-op and internship applications
// routinely demand transcripts (live QA 2026-07-16, Global Relay: "In order to be considered for
// this role, you must include post-secondary transcripts", with a second Attach input Litos
// left as "(no file)").
//
// Why this does NOT simply flag every extra file input: Ashby renders its own "autofill from
// resume" PARSER widget as a second `input[type=file]` (see the header of ashby.ts - it is the trap
// that once made the resume attach to the wrong control). Flagging that would fire a false "this
// form needs a document I don't have" on every single Ashby form, and a warning that cries wolf on
// every form is worse than no warning at all: the student learns to scroll past the one form where
// it was true. So an input only counts on a POSITIVE signal - explicitly required, or a label that
// names a document we know we cannot produce.
// "proof of" swallows the word or two after it because match()[0] becomes the user-facing name of
// the document: "proof of enrollment left for you" reads right where a bare "proof of left for
// you" reads broken.
const DOCUMENT_LABELS =
  /transcript|cover.?letter|portfolio|writing sample|reference letter|letter of recommendation|certificate|diploma|proof of [\w-]+(?: [\w-]+)?|work sample/i;

// Wording that identifies an ATS's own resume-parsing helper rather than a document slot.
const PARSER_WIDGET_LABELS = /autofill|auto-fill|parse|import your|upload your resume to/i;

// The resume slot itself. Every adapter already reports its own resume outcome ("resume: no file
// input found" / "no generated resume file available"), so this must never double-report it.
// Both e's are optionally accented: a form labelled "Résumé" is common, and `\bresum` cannot match
// "résum" (é is not e). Note there is no trailing \b - JS word boundaries are ASCII-based, so é is
// a NON-word character and \b after it would never match "résumé" at end of string.
const RESUME_LABELS = /\br[eé]sum|\bcv\b/i;

// `||` not `??`, for the reason radioOptionsIn documents above: a source that EXISTS but renders no
// text yields "", which is non-null, so `??` would stop there and never reach the next source.
function fileInputLabelText(el: HTMLInputElement): string {
  const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : '';
  const container = el.closest('.field-wrapper, .field, fieldset, [class*="_fieldEntry_"], li, div');
  const text =
    byFor ||
    el.getAttribute('aria-label') ||
    el.closest('label')?.textContent ||
    container?.textContent?.slice(0, 300) ||
    '';
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Every non-resume document slot this form needs that Litos cannot fill, as ready-to-push skip
// reasons. "left for" is load-bearing, same as the other reason builders: it makes the auto-submit
// gate HOLD and puts the item in the card's flagged list, which is the entire point - the student
// learns at fill time, not at submit time.
//
// `resumeEl` is optional because only some adapters hold the element (the others resolve it inside
// their own fillResumeFile). It is not load-bearing: called AFTER the resume is attached, the slot
// excludes itself, since a just-attached input has files. RESUME_LABELS covers the case where the
// attach failed and the input is still empty.
// The DECISION, split out from the DOM walk below so it can be unit-tested: this repo has no DOM
// test environment (every existing test is pure), and adding one would mean touching package.json.
// The guards are where the real risk lives, so they are the part that must be covered.
export function documentSlotReason(label: string, required: boolean): string | null {
  if (PARSER_WIDGET_LABELS.test(label)) return null; // the ATS's own resume parser, not a document
  if (RESUME_LABELS.test(label)) return null; // the resume slot, reported by the adapter itself
  const named = DOCUMENT_LABELS.test(label);
  if (!required && !named) return null; // no positive signal: stay quiet rather than cry wolf
  const what = label.match(DOCUMENT_LABELS)?.[0] ?? 'a document';
  return `${what} left for you: Litos only generates a resume, so attach this one yourself`;
}

export function unattachableDocumentReasons(resumeEl?: HTMLInputElement | null): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const el of document.querySelectorAll<HTMLInputElement>('input[type="file"]')) {
    if (el === resumeEl) continue;
    if (el.closest('[id*="litos"]')) continue; // our own card
    if (el.files?.length) continue; // already attached (this is how the resume slot excludes itself)
    const reason = documentSlotReason(
      fileInputLabelText(el),
      el.required || el.getAttribute('aria-required') === 'true',
    );
    if (!reason || seen.has(reason)) continue; // one dropzone can back several inputs; say it once
    seen.add(reason);
    reasons.push(reason);
  }
  return reasons;
}

// ─── Combobox / react-select filling ────────────────────────────────────────
// Modern ATS forms (Greenhouse's current template, Workday, Ashby's location field) render
// their city / yes-no / EEO / country questions as react-select comboboxes: a styled <div>
// control with a hidden role=combobox <input>, whose options only exist in the DOM AFTER the
// menu opens - often in a portal appended to <body>, not under the control. A plain
// `input.value = x` does nothing to these, which is why they were previously collected and then
// skipped. These helpers drive them the way a real user does: open on mousedown, read the
// rendered options, click the matching one.

export interface ComboOption {
  text: string;
  el: HTMLElement;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// react-select and most listbox widgets open (and select) on a real pointer/mouse sequence,
// not a bare `.click()` - dispatch the full sequence so the framework's handlers fire.
function realPointerSequence(el: HTMLElement): void {
  const base = { bubbles: true, cancelable: true, view: window } as const;
  try { el.dispatchEvent(new PointerEvent('pointerdown', base)); } catch { /* older engines */ }
  el.dispatchEvent(new MouseEvent('mousedown', base));
  try { el.dispatchEvent(new PointerEvent('pointerup', base)); } catch { /* older engines */ }
  el.dispatchEvent(new MouseEvent('mouseup', base));
  el.dispatchEvent(new MouseEvent('click', base));
}

// Is this element (or its ancestry) a combobox-style widget rather than a plain text field?
// Deliberately does NOT match a bare `[class*="-control"]`: that would catch Bootstrap's
// `form-control` on ordinary text inputs. react-select v5 sets role="combobox" on its own input,
// so the role/aria checks cover the common case without that false positive.
export function isComboboxControl(el: Element): boolean {
  return (
    el.getAttribute('role') === 'combobox' ||
    el.getAttribute('aria-haspopup') === 'listbox' ||
    el.getAttribute('aria-autocomplete') === 'list' ||
    !!el.closest('[class*="select__control"], [class*="Select-control"]')
  );
}

// The clickable control for a combobox: for react-select the role=combobox <input> is buried
// inside a `*__control` div that is what actually opens the menu, so climb to it when present.
function comboControl(trigger: HTMLElement): HTMLElement {
  return (
    trigger.closest<HTMLElement>('[class*="select__control"], [class*="-control"], [class*="Select-control"]') ??
    trigger
  );
}

// Read the option nodes rendered for THIS combobox, keeping only visible, non-empty ones.
// react-select portals its menu onto <body>, so options usually aren't descendants of the
// control - but the control's input carries aria-controls/aria-owns pointing at its listbox,
// which lets us scope the read to this widget's own menu and never pick up a stale or foreign
// listbox that happens to be open elsewhere on the page. Falls back to a document-wide read when
// no such link exists (unchanged behavior for widgets without the ARIA wiring).
function readRenderedOptions(scope?: Element | null): ComboOption[] {
  let root: ParentNode = document;
  if (scope) {
    const input =
      (scope instanceof HTMLInputElement ? scope : null) ??
      scope.querySelector<HTMLElement>('input[role="combobox"], input') ??
      scope;
    const owns =
      input.getAttribute?.('aria-controls') ||
      input.getAttribute?.('aria-owns') ||
      scope.getAttribute?.('aria-controls') ||
      scope.getAttribute?.('aria-owns');
    const listbox = owns ? document.getElementById(owns) : null;
    if (listbox) root = listbox;
  }
  const nodes = [
    ...root.querySelectorAll<HTMLElement>(
      '[role="option"], [class*="select__option"], [class*="Select-option"]',
    ),
  ];
  const seen = new Set<HTMLElement>();
  const out: ComboOption[] = [];
  for (const el of nodes) {
    if (seen.has(el)) continue;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (rect.width > 0 && rect.height > 0 && text) out.push({ text, el });
  }
  return out;
}

// Open a combobox and return its options. react-select (the widget Greenhouse, Ashby, and
// Workday build their city / country / yes-no / EEO fields on) does NOT open from a bare
// mousedown on the outer *__control div - verified live on job-boards.greenhouse.io, where the
// 244-option country picker stayed closed to a control mousedown but opened from a pointer
// sequence on the inner input and from a keyboard ArrowDown. So try the reliable paths in order
// and stop the moment options render. Handles the typeahead-only variant (no options until a
// query is typed) last, by seeding the input.
export async function openCombobox(
  trigger: HTMLElement,
  typeahead?: string,
  timeoutMs = 1600,
): Promise<ComboOption[]> {
  const control = comboControl(trigger);
  const input =
    (trigger instanceof HTMLInputElement ? trigger : null) ??
    control.querySelector<HTMLInputElement>('input');
  const focusTarget: HTMLElement = input ?? control;
  control.scrollIntoView({ block: 'center' });
  await pause(40);

  const waitForOptions = async (budgetMs: number): Promise<ComboOption[]> => {
    const start = Date.now();
    let found = readRenderedOptions(input ?? control);
    while (found.length === 0 && Date.now() - start < budgetMs) {
      await pause(60);
      found = readRenderedOptions(input ?? control);
    }
    return found;
  };

  // 1) focus + pointer sequence on the inner input (the path that opens react-select).
  focusTarget.focus?.();
  realPointerSequence(input ?? control);
  let opts = await waitForOptions(450);

  // 2) pointer sequence on the outer control (native ARIA comboboxes, Workday listbox buttons).
  if (opts.length === 0) {
    realPointerSequence(control);
    opts = await waitForOptions(350);
  }

  // 3) keyboard open: ArrowDown on the focused control, honored by react-select and most listboxes.
  if (opts.length === 0) {
    focusTarget.focus?.();
    focusTarget.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }),
    );
    opts = await waitForOptions(450);
  }

  // 4) typeahead-only widgets stay empty until a query is typed; seed it and wait the full budget.
  if (opts.length === 0 && typeahead && input) {
    setNativeValue(input, typeahead.slice(0, 24));
    opts = await waitForOptions(timeoutMs);
  }
  return opts;
}

// Click an option the framework's way, then let the menu close.
export async function pickComboOption(option: ComboOption): Promise<void> {
  option.el.scrollIntoView({ block: 'nearest' });
  realPointerSequence(option.el);
  await pause(60);
}

// Close any open menu (e.g. no confident match) so a lingering portal doesn't cover the form.
export function closeOpenCombobox(): void {
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  (document.activeElement as HTMLElement | null)?.blur?.();
}

// ─── Async location combobox (R-002) ────────────────────────────────────────
// Ashby's location/residence picker is a step past the widgets above: role="combobox" with
// aria-controls pointing at a listbox whose options come from a NETWORK lookup that lands about
// 700ms after the last keystroke (measured live on Espa Labs, 2026-07-17). Two things defeat a
// naive fill there, both confirmed on the real form:
//   1. The query must be specific enough. Typing "Dubai" alone rendered no listbox at all;
//      typing "Dubai, United Arab Emirates" returned exactly one option. locationComboQueries
//      (generic.ts) builds that fuller form from stored profile values only.
//   2. Typed text that never selects an option commits NOTHING. The input can visibly read
//      "Dubai" while the form still holds an empty value - which is how three live forms bounced
//      at submit on a field that looked filled. Only clicking a rendered option commits, after
//      which the input settles to the option's text with aria-expanded="false".
// So this drives the picker the way the QA session proved works by hand on five forms: type the
// fuller query, POLL for the async listbox (bounded, never a fixed sleep), click the matching
// option with a real element.click(), then VERIFY by reading the control back. Same
// read-back-and-verify discipline as fillDateField (R-014).

const normalizeOptionText = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

// realPointerSequence's cousin, minus the synthetic click (the caller follows with a REAL
// element.click(), see the commit step below) and minus `view: window` in the init: `view` is
// optional, nothing in these widgets reads it, and jsdom - where the unit tests for this driver
// run - rejects the global window proxy as a Window while real browsers accept either.
function pressSequence(el: HTMLElement): void {
  const base = { bubbles: true, cancelable: true } as const;
  try { el.dispatchEvent(new PointerEvent('pointerdown', base)); } catch { /* older engines */ }
  el.dispatchEvent(new MouseEvent('mousedown', base));
  try { el.dispatchEvent(new PointerEvent('pointerup', base)); } catch { /* older engines */ }
  el.dispatchEvent(new MouseEvent('mouseup', base));
}

// Which rendered option IS the stored location? Containment against the typed query, in either
// direction: Espa returned "United Arab Emirates" for the query "Dubai, United Arab Emirates"
// (option inside query), while Google-places-style pickers return "Dubai, Dubai, United Arab
// Emirates" (query inside option). Among options inside the query prefer the LONGEST (the most
// specific unit matched); among options containing the query prefer the SHORTEST (the least
// unasked-for geography). The 3-char floor keeps a stray "AL"-style fragment from matching by
// accident. Anything that matches in neither direction is NOT the stored location, and clicking
// it anyway would be a mis-fill of the R-004 class - so no match means no click, ever.
export function matchLocationOption(options: ComboOption[], query: string): ComboOption | null {
  const q = normalizeOptionText(query);
  if (!q) return null;
  let within: ComboOption | null = null;
  let containing: ComboOption | null = null;
  for (const o of options) {
    const t = normalizeOptionText(o.text);
    if (t.length < 3) continue;
    if (t === q) return o;
    if (q.includes(t)) {
      if (!within || t.length > normalizeOptionText(within.text).length) within = o;
    } else if (t.includes(q)) {
      if (!containing || t.length < normalizeOptionText(containing.text).length) containing = o;
    }
  }
  return within ?? containing;
}

// A failed drive must not leave a filled-LOOKING input. The typed query is visible in the box but
// nothing was committed, which is exactly the lie the register documents (value="Dubai", form
// holds nothing) - and worse here, because the card is about to say "left for you" about a field
// the student sees as full. Clear it and close any open menu so what she sees matches the flag.
function abandonTypedQuery(input: HTMLInputElement): null {
  setNativeValue(input, '');
  closeOpenCombobox();
  return null;
}

// Read the committed value back. The input's own value is the Ashby shape (it settles to the
// option's text); a classic react-select instead EMPTIES its input and renders the selection as a
// singleValue node, so check that too - but only inside the caller's own question block, never
// document-wide, or an adjacent field's selection could vouch for this one.
function readCommittedValue(input: HTMLInputElement, scope?: Element): string {
  const own = input.value.trim();
  if (own) return own;
  const single = scope?.querySelector('[class*="singleValue"], [class*="single-value"]');
  return single?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

// Returns the committed text, or null after cleaning up - and only ever null when the field was
// genuinely not committed, so the caller's fallback is the flag path, not a guess.
export async function driveAsyncLocationCombobox(
  input: HTMLInputElement,
  queries: string[],
  scope?: Element,
  timeoutMs = 4000,
  pollMs = 100,
): Promise<string | null> {
  if (queries.length === 0) return null;
  input.scrollIntoView?.({ block: 'center' });

  // Engage the widget the way a user does before typing, then write the query in one
  // React-visible stroke: setNativeValue is the native prototype setter plus bubbling input and
  // change, the exact sequence React's controlled inputs listen for (E-007). The queries run
  // fullest-first; a later, barer query only gets typed when the fuller one rendered nothing
  // (preloaded pickers filter by containment and need the bare unit).
  let options: ComboOption[] = [];
  let typed = '';
  for (const query of queries) {
    typed = query;
    input.focus();
    pressSequence(input);
    input.click();
    setNativeValue(input, query);
    // Poll for the async listbox - never a fixed sleep. ~700ms is the measured latency; the
    // budget is a few multiples of it, and the poll exits the moment options render.
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      options = readRenderedOptions(input);
      if (options.length > 0 || Date.now() >= deadline) break;
      await pause(pollMs);
    }
    if (options.length > 0) break;
  }
  // Match against the FULLEST query regardless of which one rendered the options: it names every
  // stored unit, so it is the strictest containment test available.
  const match = matchLocationOption(options, queries[0]);
  if (!match) return abandonTypedQuery(input);

  // Commit with a real element.click(). E-009 caught synthetic-only mouse events not landing on
  // React handlers, and the harness run that proved this sequence used a real click; the pointer
  // preamble is still sent first because react-select commits on mousedown, Ashby's listbox on
  // click - this fires both shapes on the same element.
  pressSequence(match.el);
  match.el.click();

  // VERIFY the commit before claiming the fill: wait for the widget to settle (listbox gone,
  // aria-expanded no longer "true"), then read the control back. The input holding the TYPED text
  // with the menu still open is precisely the uncommitted state, which is why settling is checked
  // before the value is trusted.
  const verifyDeadline = Date.now() + Math.max(1500, pollMs * 4);
  for (;;) {
    const settled =
      input.getAttribute('aria-expanded') !== 'true' && readRenderedOptions(input).length === 0;
    if (settled) {
      const got = readCommittedValue(input, scope);
      if (!got) return abandonTypedQuery(input);
      const g = normalizeOptionText(got);
      const opt = normalizeOptionText(match.text);
      const q = normalizeOptionText(typed);
      // The committed text must be RELATED to what was chosen or asked for, in either containment
      // direction. Anything else means the widget committed something we did not choose - report
      // that as not-committed and let the human see the flag, never claim it as a fill.
      if (g === opt || opt.includes(g) || g.includes(opt) || q.includes(g) || g.includes(q)) return got;
      return abandonTypedQuery(input);
    }
    if (Date.now() >= verifyDeadline) return abandonTypedQuery(input);
    await pause(pollMs);
  }
}
