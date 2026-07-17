// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { fillDateField } from './generic';

// The rest of the adapter suite is deliberately DOM-free, but fillDateField's whole job is the
// write-then-read-back loop, and that cannot be proven without a control that pushes back the way
// a real one does. So this file (and only this file) runs in jsdom, with a stand-in for the widget
// that actually caused R-014.
//
// The stand-in mirrors how a React controlled input really behaves, which is also why RoleQuick's
// setNativeValue exists: the native prototype setter writes the DOM value and dispatches `input`,
// the component's handler reads it, and a re-render writes back whatever the component's state now
// holds. So the fake validates on the `input` event and writes back through the prototype setter -
// an instance-level value override would be bypassed by setNativeValue entirely (it calls the
// prototype setter by design) and would prove nothing.
function pickerThatAccepts(accepts: (v: string) => boolean, attrs: Record<string, string> = {}) {
  const el = document.createElement('input');
  el.type = 'text';
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  el.addEventListener('input', () => {
    // Re-render: the component keeps the value only if its own parser understood it, else its
    // state stays empty and the box is cleared. This is the R-014 failure in miniature.
    if (!accepts(el.value)) nativeSet.call(el, '');
  });
  return el;
}

// Enpal's start-date picker, as measured live 2026-07-17: it parses MM/DD/YYYY, so a value whose
// month slot is out of range is rejected. The pre-fix code wrote "18/07/2026" (month=18), the box
// displayed it, the state held nothing, and the submit bounced on a "missing" field that visibly
// had content.
const monthFirstPicker = () =>
  pickerThatAccepts((v) => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
    return !!m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31;
  }, { placeholder: 'MM/DD/YYYY' });

// Publishes no mask and only accepts ISO: exercises the verified fallback sweep.
const isoOnlyPicker = () => pickerThatAccepts((v) => /^\d{4}-\d{2}-\d{2}$/.test(v));

describe('fillDateField', () => {
  it('writes a Dubai-stored date into a month-first picker (the R-014 regression)', async () => {
    const el = monthFirstPicker();
    expect(await fillDateField(el, '18/07/2026')).toBe(true);
    // The point of the whole fix: reordered to what the widget parses, so its state really holds it.
    expect(el.value).toBe('07/18/2026');
  });

  it('writes an ISO-stored date into a month-first picker', async () => {
    const el = monthFirstPicker();
    expect(await fillDateField(el, '2026-07-18')).toBe(true);
    expect(el.value).toBe('07/18/2026');
  });

  it('sweeps to an order the widget accepts when it publishes no mask', async () => {
    const el = isoOnlyPicker();
    expect(await fillDateField(el, '18/07/2026')).toBe(true);
    expect(el.value).toBe('2026-07-18');
  });

  it('never writes a non-date into a date field', async () => {
    const el = monthFirstPicker();
    expect(await fillDateField(el, 'Immediately')).toBe(false);
    expect(el.value).toBe('');
  });

  it('never guesses an ambiguous date', async () => {
    const el = monthFirstPicker();
    // A month-first picker would accept 03/04/2026 verbatim - as 4 March, which may not be the day
    // she meant. Committing it is precisely the silent wrong answer to avoid.
    expect(await fillDateField(el, '03/04/2026')).toBe(false);
    expect(el.value).toBe('');
  });

  it('leaves the field empty when nothing round-trips, rather than looking filled', async () => {
    const el = pickerThatAccepts(() => false);
    expect(await fillDateField(el, '2026-07-18')).toBe(false);
    expect(el.value).toBe('');
  });

  it('uses ISO for a native date input', async () => {
    const el = document.createElement('input');
    el.type = 'date';
    expect(await fillDateField(el, '18/07/2026')).toBe(true);
    expect(el.value).toBe('2026-07-18');
  });
});
