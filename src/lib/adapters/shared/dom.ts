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
