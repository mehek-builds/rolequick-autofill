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
// see it as a real edit rather than a value poke they'll overwrite on next render.
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export async function fillField(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await randomDelay();
  el.focus();
  setNativeValue(el, value);
  el.blur();
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
const THIRD_PARTY_RE = /\b(reference|references|referee|referees|emergency|guardian|next of kin|kin)\b/i;

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
