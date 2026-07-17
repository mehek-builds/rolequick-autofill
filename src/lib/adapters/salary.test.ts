import { describe, it, expect } from 'vitest';
import {
  detectCurrency,
  findStatedRanges,
  parseAshbyPostingRef,
  resolveSalary,
  salarySkipReason,
  selectPostingCompensation,
  statedRangeInJd,
  statedRangeInLabel,
  type SalaryQuestionContext,
  type StoredSalary,
} from './salary';
import { skippedReasonsNeedReview, selectNeedsYouReasons } from '../autosubmit-gate';

// The salary rule (R-031 + R-011), pinned in both directions per the repo's standing lesson:
// every case that must FILL (the median rule is useless if it never fires) and every case that
// must FLAG (the currency gate is the fix, and a flag that does not hold auto-submit is not a
// flag). The DOM halves - the adapter branches that route a real control here - live in
// salary-fill.test.ts.

const FIGURE_EUR: StoredSalary = { value: '80000', currency: 'EUR' };
const PROSE: StoredSalary = { value: 'Negotiable, open to your standard intern rate' };

const ctx = (over: Partial<SalaryQuestionContext>): SalaryQuestionContext => ({
  label: 'what are your salary expectations?',
  field: 'freetext',
  ...over,
});

describe('statedRangeInLabel / findStatedRanges', () => {
  it('parses "usd 90,000 - 110,000" (labels arrive lowercased) into its median, posting-formatted', () => {
    const r = statedRangeInLabel('expected salary (usd 90,000 - 110,000)');
    expect(r).not.toBeNull();
    expect(r!.median).toBe(100000);
    expect(r!.fillText).toBe('USD 100,000');
    expect(r!.fillNumeric).toBe('100000');
    expect(r!.currency).toBe('USD');
  });

  it('parses "$40-50/hr" and keeps the posting\'s own symbol and unit', () => {
    const r = statedRangeInLabel('hourly pay: $40-50/hr');
    expect(r).not.toBeNull();
    expect(r!.fillText).toBe('$45/hr');
    expect(r!.fillNumeric).toBe('45');
    // A bare $ is a dollar of unknown nationality: usable as the posting's own format, never as
    // a resolved currency for the stored-figure gate.
    expect(r!.currency).toBeNull();
  });

  it('parses EU-grouped "eur 55.000-65.000" and formats the median the same way', () => {
    const r = statedRangeInLabel('gehalt: eur 55.000-65.000');
    expect(r).not.toBeNull();
    expect(r!.median).toBe(60000);
    expect(r!.fillText).toBe('EUR 60.000');
    expect(r!.fillNumeric).toBe('60000');
    expect(r!.currency).toBe('EUR');
  });

  it('parses a k-suffixed shorthand ("90-110k") scaling both sides', () => {
    const r = statedRangeInLabel('salary band 90-110k');
    expect(r).not.toBeNull();
    expect(r!.min).toBe(90000);
    expect(r!.max).toBe(110000);
    expect(r!.fillText).toBe('100k');
    expect(r!.fillNumeric).toBe('100000');
  });

  it('a trailing currency code ("55,000 - 65,000 aed") is kept in the posting\'s position', () => {
    const r = statedRangeInLabel('monthly salary 55,000 - 65,000 aed');
    expect(r!.fillText).toBe('60,000 AED');
    expect(r!.currency).toBe('AED');
  });

  it('never reads a year pair or a small unqualified pair as a salary range', () => {
    expect(statedRangeInLabel('available 2024-2026, expected salary?')).toBeNull();
    expect(statedRangeInLabel('expected salary and availability (10-12 weeks)')).toBeNull();
  });

  it('two different ranges in one label resolve nothing (ambiguity never fills)', () => {
    expect(statedRangeInLabel('salary usd 90,000-110,000 or eur 80.000-95.000')).toBeNull();
  });

  it('a word-boundary guard keeps a code-shaped word tail from resolving', () => {
    expect(findStatedRanges('top 100-200 employees')).toHaveLength(0);
  });
});

describe('statedRangeInJd', () => {
  it('finds the single range adjacent to compensation wording', () => {
    const jd = `About us. Great team. Compensation: USD 90,000 - 110,000 per year plus benefits. Apply now.`;
    const r = statedRangeInJd(jd);
    expect(r).not.toBeNull();
    expect(r!.median).toBe(100000);
  });

  it('ignores a range with no salary wording anywhere near it', () => {
    expect(
      statedRangeInJd(
        'We serve 40,000 - 50,000 customers across many countries and regions worldwide. Compensation is not disclosed here.',
      ),
    ).toBeNull();
  });

  it('two distinct salary-adjacent ranges resolve nothing', () => {
    const jd = 'Salary: USD 90,000-110,000 for SF. Salary: USD 70,000-80,000 for Austin.';
    expect(statedRangeInJd(jd)).toBeNull();
  });
});

describe('detectCurrency', () => {
  it('resolves a single named currency, lowercased or symbolic', () => {
    expect(detectCurrency('desired salary (eur)')).toBe('EUR');
    expect(detectCurrency('salary in €')).toBe('EUR');
    expect(detectCurrency('annual package, aed')).toBe('AED');
  });

  it('never resolves a bare $, an ambiguous pair, or common-word code shapes', () => {
    expect(detectCurrency('salary ($)')).toBeNull();
    expect(detectCurrency('salary in usd or eur')).toBeNull();
    // "try" is the word, not the lira; excluded from the code list on purpose.
    expect(detectCurrency('please try to state your salary')).toBeNull();
  });
});

describe('selectPostingCompensation', () => {
  const payload = (compensation: unknown) => ({
    jobs: [{ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', title: 'Intern', compensation }],
  });
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('pulls the salary component out of a tiered payload and uppercases the currency', () => {
    const comp = {
      compensationTiers: [
        {
          components: [
            { compensationType: 'Salary', currencyCode: 'usd', minValue: 90000, maxValue: 110000 },
            { compensationType: 'EquityPercentage', currencyCode: 'usd', minValue: 0.01, maxValue: 0.05 },
          ],
        },
      ],
    };
    expect(selectPostingCompensation(payload(comp), id)).toEqual({
      currencyCode: 'USD',
      minValue: 90000,
      maxValue: 110000,
    });
  });

  it('returns null on multi-tier ambiguity (two distinct bands is not one stated range)', () => {
    const comp = {
      compensationTiers: [
        { components: [{ compensationType: 'Salary', currencyCode: 'USD', minValue: 90000, maxValue: 110000 }] },
        { components: [{ compensationType: 'Salary', currencyCode: 'USD', minValue: 70000, maxValue: 80000 }] },
      ],
    };
    expect(selectPostingCompensation(payload(comp), id)).toBeNull();
  });

  it('returns null when the posting carries no usable compensation at all', () => {
    expect(selectPostingCompensation(payload(undefined), id)).toBeNull();
    expect(selectPostingCompensation(payload({ summaryComponents: [] }), id)).toBeNull();
    expect(selectPostingCompensation({ jobs: [] }, id)).toBeNull();
    expect(selectPostingCompensation(null, id)).toBeNull();
  });
});

describe('parseAshbyPostingRef (moved here from ashby.ts, contract unchanged)', () => {
  it('parses org + posting uuid from an /application URL', () => {
    expect(
      parseAshbyPostingRef('https://jobs.ashbyhq.com/espa/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/application'),
    ).toEqual({ org: 'espa', postingId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
  });

  it('returns null off-host or without a uuid', () => {
    expect(parseAshbyPostingRef('https://jobs.lever.co/x/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBeNull();
    expect(parseAshbyPostingRef('https://jobs.ashbyhq.com/espa')).toBeNull();
  });
});

describe('resolveSalary: median of the posting range, highest authority', () => {
  it('a range in the label fills its median regardless of the stored currency or value', () => {
    const r = resolveSalary(ctx({ label: 'expected salary (usd 90,000 - 110,000)' }), FIGURE_EUR);
    expect(r).toEqual({ action: 'fill', source: 'label-range', value: 'USD 100,000' });
  });

  it('numeric controls get the median as a bare number', () => {
    const r = resolveSalary(ctx({ label: 'expected salary (usd 90,000 - 110,000)', field: 'numeric' }), FIGURE_EUR);
    expect(r).toEqual({ action: 'fill', source: 'label-range', value: '100000' });
  });

  it('the Ashby compensation payload fills its median when the label states nothing', () => {
    const posting = { currencyCode: 'USD', minValue: 90000, maxValue: 110000 };
    expect(resolveSalary(ctx({ posting }), FIGURE_EUR)).toEqual({
      action: 'fill',
      source: 'posting-compensation',
      value: 'USD 100,000',
    });
    expect(resolveSalary(ctx({ posting, field: 'numeric' }), FIGURE_EUR)).toEqual({
      action: 'fill',
      source: 'posting-compensation',
      value: '100000',
    });
  });

  it('the label range outranks the compensation payload', () => {
    const posting = { currencyCode: 'EUR', minValue: 50000, maxValue: 60000 };
    const r = resolveSalary(ctx({ label: 'salary (usd 90,000 - 110,000)', posting }), FIGURE_EUR);
    expect(r).toEqual({ action: 'fill', source: 'label-range', value: 'USD 100,000' });
  });

  it('an unambiguous JD-stated range fills when neither label nor payload state one', () => {
    const jdText = 'Role details. Compensation: USD 90,000 - 110,000 per year. Benefits.';
    expect(resolveSalary(ctx({ jdText }), FIGURE_EUR)).toEqual({
      action: 'fill',
      source: 'jd-range',
      value: 'USD 100,000 per year',
    });
  });
});

describe('resolveSalary: the stored fallback behind the currency gate', () => {
  it('EUR posting + EUR stored figure fills, un-grouped for numeric controls', () => {
    expect(resolveSalary(ctx({ label: 'desired salary (eur)' }), FIGURE_EUR)).toEqual({
      action: 'fill',
      source: 'stored-figure',
      value: '80000',
    });
    expect(
      resolveSalary(ctx({ label: 'desired salary (eur)', field: 'numeric' }), { value: '80,000', currency: 'EUR' }),
    ).toEqual({ action: 'fill', source: 'stored-figure', value: '80000' });
  });

  it('the JD currency can satisfy the gate when the label names none', () => {
    const jdText = 'What we offer: a competitive salary in EUR, learning budget, relocation.';
    expect(resolveSalary(ctx({ jdText }), FIGURE_EUR)).toEqual({
      action: 'fill',
      source: 'stored-figure',
      value: '80000',
    });
  });

  it('USD posting + EUR stored figure flags and NEVER converts', () => {
    const r = resolveSalary(ctx({ label: 'desired salary (usd)' }), FIGURE_EUR);
    expect(r.action).toBe('flag');
    const reason = (r as { reason: string }).reason;
    expect(reason).toContain('USD');
    expect(reason).toContain('EUR');
    expect(reason).toContain('never converted');
    expect(reason).toMatch(/left for you/);
  });

  it('no currency signal anywhere flags a numeric field instead of filling the bare figure', () => {
    const r = resolveSalary(ctx({ field: 'numeric' }), FIGURE_EUR);
    expect(r.action).toBe('flag');
    expect((r as { reason: string }).reason).toMatch(/couldn't confirm the posting's currency/);
  });

  it('a stored figure with no stored currency flags even when the posting currency resolves', () => {
    const r = resolveSalary(ctx({ label: 'desired salary (usd)' }), { value: '80000' });
    expect(r.action).toBe('flag');
    expect((r as { reason: string }).reason).toMatch(/left for you/);
  });

  it('a free-text field with no posting range keeps the stored Negotiable sentence', () => {
    expect(resolveSalary(ctx({}), PROSE)).toEqual({
      action: 'fill',
      source: 'stored-prose',
      value: 'Negotiable, open to your standard intern rate',
    });
  });

  it('a stored prose value never enters a numeric field', () => {
    const r = resolveSalary(ctx({ field: 'numeric' }), PROSE);
    expect(r.action).toBe('flag');
    expect((r as { reason: string }).reason).toMatch(/left for you/);
  });

  it('nothing stored and nothing stated flags rather than falling through silently', () => {
    const r = resolveSalary(ctx({}), {});
    expect(r.action).toBe('flag');
    expect((r as { reason: string }).reason).toMatch(/no salary answer in your profile/);
  });
});

describe('the flag engages the auto-submit hold', () => {
  it('every flag variant matches REVIEW_FLAG and surfaces on the "Still needs you" list', () => {
    const flags = [
      resolveSalary(ctx({ field: 'numeric' }), FIGURE_EUR),
      resolveSalary(ctx({ label: 'desired salary (usd)' }), FIGURE_EUR),
      resolveSalary(ctx({ field: 'numeric' }), PROSE),
      resolveSalary(ctx({}), {}),
    ];
    for (const f of flags) {
      expect(f.action).toBe('flag');
      const reason = (f as { reason: string }).reason;
      // The hold: autosubmit-gate's REVIEW_FLAG must classify this as needing the student.
      expect(skippedReasonsNeedReview([reason])).toBe(true);
      // The card: it must survive the "Still needs you" filter, not just the hold.
      expect(selectNeedsYouReasons([reason])).toEqual([reason]);
    }
  });

  it('salarySkipReason carries the label and the load-bearing phrasing', () => {
    const reason = salarySkipReason('what are your salary expectations?', 'detail here');
    expect(reason).toBe('salary question left for you (detail here): "what are your salary expectations?"');
    expect(skippedReasonsNeedReview([reason])).toBe(true);
  });
});
