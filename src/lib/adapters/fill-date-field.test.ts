// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { fillDateField } from './generic';

// The rest of the adapter suite is deliberately DOM-free, but fillDateField's whole job is the
// write-then-read-back loop, and that cannot be proven without a control that pushes back the way
// a real one does. So this file (and only this file) runs in jsdom, with a stand-in for the widget
// that actually caused R-014.
//
// The stand-in mirrors how a React controlled input really behaves, which is also why Litos's
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

describe('an ambiguous day on an unmasked picker is never guessed at', () => {
  // The case with no answer in the page. A day-first widget handed a month-first "07/08/2026" reads
  // 7 August, accepts it, and hands the text straight back, so no read-back can tell. The only way
  // to learn the order is to write a date that is not hers, and that is exactly what the deleted
  // probe did: it stranded 2026-07-13 in a widget's state and reported success. So: ISO, which is
  // unambiguous, and an honest held skip if the widget will not take it.

  it('fills via ISO when the widget accepts ISO', async () => {
    const el = isoOnlyPicker();
    expect(await fillDateField(el, '2026-07-08')).toBe(true);
    expect(el.value).toBe('2026-07-08');
  });

  it('SKIPS rather than guess when the widget takes only slashes', async () => {
    // Reported as a skip, which holds auto-submit and puts the field in "still needs you". A blank
    // box the student fills is recoverable; a date from nowhere on a submitted application is not.
    const { el, committed } = dmyPickerNoMask();
    expect(await fillDateField(el, '2026-07-08')).toBe(false);
    expect(el.value).toBe('');
    expect(committed()).toBeNull();
  });

  it('writes NOTHING that is not her own date, whatever the widget does', async () => {
    // The regression that deleted the probe: it wrote 13/07/2026 to interrogate the widget, could
    // not withdraw it, and the form kept it. Nothing may be written but her value.
    const seen: string[] = [];
    const el = document.createElement('input');
    el.type = 'text';
    el.addEventListener('input', () => { if (el.value) seen.push(el.value); });
    await fillDateField(el, '2026-07-08');
    for (const v of seen) expect(v).toBe('2026-07-08');
  });
});

describe('the day > 12 sweep still fills, which is every slash-typed date', () => {
  // parseStoredDate only resolves a slash date when one component is > 12, and assigns it to `day`.
  // So every date typed into onboarding (placeholder: MM/DD/YYYY) lands here, not in the ISO branch.
  it('fills a day-first picker', async () => {
    const { el, committed } = dmyPickerNoMask();
    expect(await fillDateField(el, '18/07/2026')).toBe(true);
    expect(committed()).toBe('2026-07-18');
  });

  it('fills a month-first picker', async () => {
    const el = monthFirstPicker();
    expect(await fillDateField(el, '18/07/2026')).toBe(true);
    expect(el.value).toBe('07/18/2026');
  });

  it('fills her real stored dates on an unmasked day-first picker', async () => {
    // Her actual profile: availability 2026-07-18, DOB 2005-09-25. Both day > 12.
    for (const [stored, iso] of [['2026-07-18', '2026-07-18'], ['2005-09-25', '2005-09-25']]) {
      const { el, committed } = dmyPickerNoMask();
      expect(await fillDateField(el, stored)).toBe(true);
      expect(committed()).toBe(iso);
    }
  });
});
