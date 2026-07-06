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
