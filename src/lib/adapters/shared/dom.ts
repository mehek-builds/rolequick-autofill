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

// Radios that carry no meaningful `value` (Ashby/LinkedIn use "on"): the real option text lives
// in the associated `label[for=radio.id]`. Returns each radio paired with its label text.
export function radioOptionsIn(block: Element): Array<{ radio: HTMLInputElement; text: string }> {
  return [...block.querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((radio) => ({
    radio,
    text: (document.querySelector(`label[for="${radio.id}"]`)?.textContent ?? '').trim().toLowerCase(),
  }));
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

// Read the option nodes currently rendered anywhere in the document (react-select portals its
// menu onto <body>), keeping only visible, non-empty ones.
function readRenderedOptions(): ComboOption[] {
  const nodes = [
    ...document.querySelectorAll<HTMLElement>(
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

// Open a combobox and return its options. Handles the typeahead-only variant (no options until
// you type) by seeding the input with `typeahead` when the freshly-opened menu is empty.
export async function openCombobox(
  trigger: HTMLElement,
  typeahead?: string,
  timeoutMs = 1600,
): Promise<ComboOption[]> {
  const control = comboControl(trigger);
  control.scrollIntoView({ block: 'center' });
  await pause(40);
  realPointerSequence(control);
  const input =
    (trigger instanceof HTMLInputElement ? trigger : null) ??
    control.querySelector<HTMLInputElement>('input');
  input?.focus();

  const started = Date.now();
  let opts = readRenderedOptions();
  while (opts.length === 0 && Date.now() - started < timeoutMs) {
    await pause(70);
    opts = readRenderedOptions();
  }

  // Typeahead widgets stay empty until a query is typed; seed it and wait again.
  if (opts.length === 0 && typeahead && input) {
    setNativeValue(input, typeahead.slice(0, 24));
    const t2 = Date.now();
    while (opts.length === 0 && Date.now() - t2 < timeoutMs) {
      await pause(70);
      opts = readRenderedOptions();
    }
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
