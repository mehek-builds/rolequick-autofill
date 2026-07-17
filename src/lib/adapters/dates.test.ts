import { describe, it, expect } from 'vitest';
import {
  dateOrderCandidates,
  detectDateOrder,
  formatDate,
  isDateControl,
  parseStoredDate,
  valueHoldsDate,
} from './shared/dates';
import { desiredAnswer, dateSkipReason } from './generic';
import type { ApplicationProfile } from '../types';
import { skippedReasonsNeedReview } from '../autosubmit-gate';

const ap = (over: Partial<ApplicationProfile> = {}): ApplicationProfile => ({ ...over });
const input = (attrs: Record<string, string> = {}, type = 'text') =>
  ({
    type,
    getAttribute: (k: string) => attrs[k] ?? null,
  }) as unknown as Element;

describe('parseStoredDate', () => {
  it('parses ISO, the format the profile should store', () => {
    expect(parseStoredDate('2026-07-18')).toEqual({ year: 2026, month: 7, day: 18 });
    expect(parseStoredDate('2005-09-25')).toEqual({ year: 2005, month: 9, day: 25 });
  });

  it('resolves a slash date when one component cannot be a month', () => {
    // Mehek's Dubai-shaped stored value, the one that broke Enpal.
    expect(parseStoredDate('18/07/2026')).toEqual({ year: 2026, month: 7, day: 18 });
    // ...and the US shape of the same day.
    expect(parseStoredDate('07/18/2026')).toEqual({ year: 2026, month: 7, day: 18 });
  });

  it('refuses to guess a genuinely ambiguous date', () => {
    // 3 April in Dubai, 4 March in California, and nothing in the string says which. Guessing here
    // is the silent wrong answer this module exists to prevent.
    expect(parseStoredDate('03/04/2026')).toBeNull();
    expect(parseStoredDate('01/02/2027')).toBeNull();
  });

  it('returns null for a value that is not a date at all', () => {
    // The real stored availability_date for most of the QA session (R-014 facet b).
    expect(parseStoredDate('Immediately')).toBeNull();
    expect(parseStoredDate('ASAP')).toBeNull();
    expect(parseStoredDate('14 weeks')).toBeNull();
    expect(parseStoredDate('')).toBeNull();
    expect(parseStoredDate(undefined)).toBeNull();
  });

  it('rejects impossible dates rather than rolling them over', () => {
    expect(parseStoredDate('2026-02-30')).toBeNull();
    expect(parseStoredDate('2026-13-01')).toBeNull();
    expect(parseStoredDate('31/04/2026')).toBeNull();
    expect(parseStoredDate('2027-02-29')).toBeNull(); // not a leap year
    expect(parseStoredDate('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 }); // is one
  });
});

describe('detectDateOrder', () => {
  it('reads the mask the widget already publishes', () => {
    expect(detectDateOrder(input({ placeholder: 'MM/DD/YYYY' }))).toBe('mdy');
    expect(detectDateOrder(input({ placeholder: 'DD/MM/YYYY' }))).toBe('dmy');
    expect(detectDateOrder(input({ placeholder: 'YYYY-MM-DD' }))).toBe('ymd');
    // ANYbotics spells the order out in the label instead of the placeholder.
    expect(detectDateOrder(input({ 'aria-label': 'What is your date of birth? (dd/mm/yyyy)' }))).toBe('dmy');
  });

  it('treats input[type=date] as ISO regardless of how it displays', () => {
    expect(detectDateOrder(input({ placeholder: 'MM/DD/YYYY' }, 'date'))).toBe('ymd');
  });

  it('returns null when the widget publishes no hint', () => {
    expect(detectDateOrder(input({ placeholder: 'Type here...' }))).toBeNull();
    expect(detectDateOrder(null)).toBeNull();
  });
});

describe('dateOrderCandidates', () => {
  const unmasked = () => input({ placeholder: 'Type here...' });
  const dayOver12 = { year: 2026, month: 7, day: 18 };
  const dayCouldBeAMonth = { year: 2026, month: 7, day: 8 };

  it('trusts a detected order alone', () => {
    expect(dateOrderCandidates(input({ placeholder: 'DD/MM/YYYY' }), dayCouldBeAMonth)).toEqual(['dmy']);
  });

  it('sweeps slash orders when the date itself rules out the wrong reading', () => {
    // day 18 cannot be a month, so a month-first write is rejected rather than misread.
    expect(dateOrderCandidates(unmasked(), dayOver12)).toEqual(['mdy', 'dmy', 'ymd']);
  });

  it('sweeps when both readings are the same day', () => {
    expect(dateOrderCandidates(unmasked(), { year: 2026, month: 7, day: 7 })).toEqual(['mdy', 'dmy', 'ymd']);
  });

  it('offers NOTHING when an unmasked widget could misread a slash write, so the caller probes', () => {
    // 8 July: a day-first widget reads a month-first "07/08/2026" as 7 August, keeps our text
    // verbatim, and the read-back cannot tell. There is no safe order to offer blind, so this
    // returns empty and fillDateField asks the widget which order it parses (PROBE_DATE).
    // It must NOT answer ['ymd'] here: that skipped ~40% of dates on an unmasked US picker that
    // had been filling them correctly.
    expect(dateOrderCandidates(unmasked(), dayCouldBeAMonth)).toEqual([]);
  });
});

describe('valueHoldsDate', () => {
  const parts = { year: 2026, month: 7, day: 18 };

  it('fails an empty box: the exact R-014 silent failure', () => {
    // Enpal parsed month=18 out of "18/07/2026", rejected it, and left React's state empty. Any
    // check that does not notice this reports a filled field that the submit will bounce.
    expect(valueHoldsDate('', parts, 'mdy')).toBe(false);
    expect(valueHoldsDate('   ', parts, 'mdy')).toBe(false);
  });

  it('passes a value the widget kept verbatim', () => {
    expect(valueHoldsDate('07/18/2026', parts, 'mdy')).toBe(true);
  });

  it('passes a value the widget reformatted to the same day', () => {
    expect(valueHoldsDate('2026-07-18', parts, 'mdy')).toBe(true);
  });

  it('fails a value the widget turned into a different day', () => {
    // The register's proof that Enpal parses month-first: typing 18 into the day slot produced
    // 01/18/2026. A different day must never read as committed.
    expect(valueHoldsDate('01/18/2026', parts, 'mdy')).toBe(false);
  });
});

describe('formatDate', () => {
  it('zero-pads every order', () => {
    const parts = { year: 2026, month: 7, day: 8 };
    expect(formatDate(parts, 'mdy')).toBe('07/08/2026');
    expect(formatDate(parts, 'dmy')).toBe('08/07/2026');
    expect(formatDate(parts, 'ymd')).toBe('2026-07-08');
  });
});

describe('isDateControl', () => {
  it('recognizes date fields by type, label and mask', () => {
    expect(isDateControl(input({}, 'date'), 'anything')).toBe(true);
    expect(isDateControl(input({}), 'What is your earliest possible starting date?')).toBe(true);
    expect(isDateControl(input({}), 'What is your date of birth? (dd/mm/yyyy)')).toBe(true);
    expect(isDateControl(input({ placeholder: 'MM/DD/YYYY' }), 'When?')).toBe(true);
  });

  it('leaves non-date fields on the plain text path', () => {
    expect(isDateControl(input({}), 'Full name')).toBe(false);
    expect(isDateControl(input({}), 'What are your salary expectations?')).toBe(false);
  });
});

// R-014 facet (b): one opaque string was answering two different questions.
describe('availability: start date vs term', () => {
  it('answers a start-date question with the date', () => {
    expect(desiredAnswer('what is your earliest possible starting date?', ap({ availability_date: '2026-07-18' }), {}))
      .toEqual({ mode: 'value', value: '2026-07-18' });
    expect(desiredAnswer('when can you start?', ap({ availability_date: '2026-07-18' }), {}))
      .toEqual({ mode: 'value', value: '2026-07-18' });
  });

  it('answers a term question with the term, NOT the start date', () => {
    // Espa Labs, verbatim. This got "Immediately" - a start time in answer to a duration.
    const profile = ap({ availability_date: '2026-07-18', availability_term: '14 weeks' });
    expect(desiredAnswer('length or term/length of availability (10-14 weeks):', profile, {}))
      .toEqual({ mode: 'value', value: '14 weeks' });
    expect(desiredAnswer('how long are you available for an internship?', profile, {}))
      .toEqual({ mode: 'value', value: '14 weeks' });
  });

  it('leaves a term question blank rather than falling back to the start date', () => {
    // The regression that matters: with no term stored, the old /availab/ rule poured the start
    // date in. Blank is the honest answer.
    expect(desiredAnswer('length or term/length of availability (10-14 weeks):', ap({ availability_date: '2026-07-18' }), {}))
      .toBeNull();
  });
});

describe('dateSkipReason', () => {
  it('holds auto-submit, so the countdown never fires into a form the ATS will bounce', () => {
    // The wording is load-bearing: autosubmit-gate matches "left for".
    expect(skippedReasonsNeedReview([dateSkipReason('Immediately', 'Start date')])).toBe(true);
    expect(skippedReasonsNeedReview([dateSkipReason('2026-07-18', 'Start date')])).toBe(true);
  });

  it('says which problem it hit', () => {
    expect(dateSkipReason('Immediately', 'Start date')).toContain('is not an unambiguous date');
    expect(dateSkipReason('2026-07-18', 'Start date')).toContain('would not accept it');
  });
});
