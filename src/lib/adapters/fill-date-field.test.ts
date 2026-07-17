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

// The case a read-back alone cannot judge, and the reason dateOrderCandidates needs the date.
//
// Every picker above either rejects a value it cannot parse (so the read-back catches it) or
// publishes a mask (so no guessing happens). This one does neither: it is day-first and silent, so
// it ACCEPTS a month-first write, reads it as a different real day, and hands our own text straight
// back. Nothing about the box's contents reveals the mistake.
function dmyPickerNoMask() {
  const el = document.createElement('input');
  el.type = 'text';
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  let committed: string | null = null; // what the widget's own state ends up holding, as ISO
  el.addEventListener('input', () => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(el.value);
    if (m && +m[1] >= 1 && +m[1] <= 31 && +m[2] >= 1 && +m[2] <= 12) {
      committed = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; // parsed DAY-first
    } else {
      committed = null;
      nativeSet.call(el, '');
    }
  });
  return { el, committed: () => committed };
}

describe('fillDateField against an unmasked day-first picker', () => {
  it('probes the order and commits the RIGHT day, rather than guessing or skipping', async () => {
    const { el, committed } = dmyPickerNoMask();
    // 8 July 2026. A month-first "07/08/2026" would be accepted here as 7 AUGUST and read back
    // verbatim, so a blind sweep passes verification with the wrong day. The probe settles it:
    // "13/01/2026" survives this picker and "01/13/2026" does not, which names it day-first, so
    // the real write goes in day-first and the widget's own state holds 8 July.
    expect(await fillDateField(el, '2026-07-08')).toBe(true);
    expect(committed()).toBe('2026-07-08');
  });

  it('still fills when the day cannot pass for a month', async () => {
    const { el, committed } = dmyPickerNoMask();
    expect(await fillDateField(el, '2026-07-18')).toBe(true);
    expect(committed()).toBe('2026-07-18'); // month-first write bounced, day-first retry landed
  });

  it('fills an ambiguous-day date through ISO when the widget accepts ISO', async () => {
    const el = isoOnlyPicker();
    expect(await fillDateField(el, '2026-07-08')).toBe(true);
    expect(el.value).toBe('2026-07-08');
  });
});

// ─── Caught reviewing the R-014 fix itself ───────────────────────────────────────────────────
//
// The first cut answered an ambiguous day + unmasked widget with "write ISO or skip". That was
// safe and wrong: on an unmasked US month-first picker, the commonest ATS shape there is, dates
// with day <= 12 (~40% of them) had been filling CORRECTLY and started coming back blank. The
// probe recovers the fill without reintroducing the guess.

// A US month-first picker that publishes NO mask: accepts only mm/dd/yyyy, advertises nothing.
function mdyPickerNoMask() {
  const el = document.createElement('input');
  el.type = 'text';
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  let committed: string | null = null;
  el.addEventListener('input', () => {
    const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(el.value);
    if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) {
      committed = `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`; // parsed MONTH-first
    } else {
      committed = null;
      nativeSet.call(el, '');
    }
  });
  return { el, committed: () => committed };
}

describe('fillDateField probes an unmasked picker instead of guessing or skipping', () => {
  it('fills an ambiguous day on an unmasked MONTH-first picker (the regression)', async () => {
    const { el, committed } = mdyPickerNoMask();
    expect(await fillDateField(el, '2026-07-08')).toBe(true);
    expect(committed()).toBe('2026-07-08'); // 8 July, not 7 August
  });

  it('fills the same date on an unmasked DAY-first picker, the opposite order', async () => {
    const { el, committed } = dmyPickerNoMask();
    expect(await fillDateField(el, '2026-07-08')).toBe(true);
    expect(committed()).toBe('2026-07-08');
  });

  it('leaves no probe date behind when it gives up', async () => {
    // A control that accepts nothing: both probes fail, ISO fails, and the field must end EMPTY,
    // never parked with 13/01/2026 on a real application.
    const el = pickerThatAccepts(() => false);
    expect(await fillDateField(el, '2026-07-08')).toBe(false);
    expect(el.value).toBe('');
  });

  it('falls back to ISO when the widget validates nothing, rather than coin-flipping', async () => {
    // Both probes survive, so the control has told us nothing about its order. ISO is unambiguous.
    const el = pickerThatAccepts(() => true);
    expect(await fillDateField(el, '2026-07-08')).toBe(true);
    expect(el.value).toBe('2026-07-08');
  });

  it('still trusts a published mask over any probing', async () => {
    const el = monthFirstPicker(); // placeholder MM/DD/YYYY
    expect(await fillDateField(el, '2026-07-08')).toBe(true);
    expect(el.value).toBe('07/08/2026');
  });
});
