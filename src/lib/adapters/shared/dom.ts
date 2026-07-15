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
