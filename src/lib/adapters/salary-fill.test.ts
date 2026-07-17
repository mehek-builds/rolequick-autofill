// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { fillAshbyApplication } from './ashby';
import { fillGenericApplication } from './generic';
import { skippedReasonsNeedReview } from '../autosubmit-gate';
import type { PostingCompensation } from './salary';
import type { ApplicationProfile, Profile } from '../types';

// The salary rule (R-031 + R-011) through the REAL adapter loops, in jsdom (the same exception
// ashby-essay-draft.test.ts carved out: a loop's routing cannot be proven without the DOM it
// routes on). The pure rule is pinned in salary.test.ts; what these cases prove is the part that
// actually failed live: WHICH branch owns a salary control, what shape it reads the control as,
// and that the numbers/flags land in (or stay out of) the actual input.
//
// Before this branch existed: the generic adapter typed the bare stored figure into free-text
// AND type=number salary fields with no currency check (generic.ts desiredAnswer's old salary
// case), and Ashby's known-answer path did the same for text controls while a NUMERIC salary
// field was invisible to its text/url/tel selector (the Proxima Fusion mid-fill parking).

const ap = (o: Partial<ApplicationProfile> = {}): ApplicationProfile => o as ApplicationProfile;

const FIGURE_EUR = { desired_salary: '80000', desired_salary_currency: 'EUR' };
const PROSE = { desired_salary: 'Negotiable, open to your standard intern rate' };
const USD_COMP: PostingCompensation = { currencyCode: 'USD', minValue: 90000, maxValue: 110000 };

// ─── Ashby harness (same fixture shape as ashby-essay-draft.test.ts) ─────────

function fieldEntry(inner: string): void {
  const fieldset = document.createElement('fieldset');
  fieldset.className = '_fieldEntry_x1y2z';
  fieldset.innerHTML = inner;
  document.body.appendChild(fieldset);
}

function runAshby(applicationProfile: ApplicationProfile, postingCompensation?: PostingCompensation | null) {
  return fillAshbyApplication({
    fullName: '',
    profile: {} as Profile,
    applicationProfile,
    postingCompensation,
  });
}

// ─── Generic harness ─────────────────────────────────────────────────────────

// The generic adapter's candidateInputs() gates on isVisible(), which reads a layout box jsdom
// never computes, so each control gets a stubbed rect. Labels are for-associated, which is the
// strongest identity signal controlIdentity() reads.
const RECT = {
  width: 200, height: 24, top: 0, left: 0, right: 200, bottom: 24, x: 0, y: 0,
  toJSON: () => ({}),
} as DOMRect;

let seq = 0;
function genericField(labelText: string, tag: 'input' | 'textarea', type = 'text'): HTMLInputElement | HTMLTextAreaElement {
  const id = `field-${++seq}`;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;
  const el = document.createElement(tag) as HTMLInputElement | HTMLTextAreaElement;
  if (el instanceof HTMLInputElement) el.type = type;
  el.id = id;
  el.getBoundingClientRect = () => RECT;
  document.body.append(label, el);
  return el;
}

function runGeneric(applicationProfile: ApplicationProfile, draftAnswer?: (q: string) => Promise<string | null>) {
  return fillGenericApplication({
    fullName: 'Mehek Mandal',
    profile: {} as Profile,
    applicationProfile,
    draftAnswer,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Ashby salary branch', () => {
  it('a range stated in the label fills its median, regardless of the stored currency', async () => {
    fieldEntry('<label>What are your salary expectations? (USD 90,000 - 110,000)</label><input type="text" />');
    const result = await runAshby(ap(FIGURE_EUR));
    expect(document.querySelector('input')!.value).toBe('USD 100,000');
    expect(result.fields_filled).toBeGreaterThanOrEqual(1);
  });

  it("the posting API's compensation range fills a NUMERIC salary field with the bare median", async () => {
    // The exact control shape that parked Proxima Fusion: input[type=number], no unit hint. The
    // old known-answer path could not even see this input (text/url/tel selector).
    fieldEntry('<label>What are your salary expectations?</label><input type="number" />');
    const result = await runAshby(ap(FIGURE_EUR), USD_COMP);
    expect(document.querySelector('input')!.value).toBe('100000');
    expect(result.fields_filled).toBeGreaterThanOrEqual(1);
  });

  it('EUR posting + EUR stored figure fills the figure', async () => {
    fieldEntry('<label>Desired salary (EUR)</label><input type="text" />');
    await runAshby(ap(FIGURE_EUR));
    expect(document.querySelector('input')!.value).toBe('80000');
  });

  it('USD posting + EUR stored figure flags, never converts, and the flag holds auto-submit', async () => {
    fieldEntry('<label>Salary expectations (USD)</label><input type="text" />');
    const result = await runAshby(ap(FIGURE_EUR));
    expect(document.querySelector('input')!.value).toBe('');
    const reason = result.skipped_reasons.find((r) => r.startsWith('salary question left for you'));
    expect(reason).toBeDefined();
    expect(reason).toContain('USD');
    expect(reason).toContain('EUR');
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  });

  it('a free-text salary question with no stated range keeps the stored Negotiable sentence', async () => {
    fieldEntry('<label>What are your salary expectations?</label><input type="text" />');
    await runAshby(ap(PROSE));
    expect(document.querySelector('input')!.value).toBe('Negotiable, open to your standard intern rate');
  });

  it('a stored prose answer never enters a type=number control: flag instead', async () => {
    fieldEntry('<label>What are your salary expectations?</label><input type="number" />');
    const result = await runAshby(ap(PROSE));
    expect(document.querySelector('input')!.value).toBe('');
    expect(result.skipped_reasons.some((r) => r.startsWith('salary question left for you'))).toBe(true);
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  });
});

describe('generic-adapter salary branch', () => {
  it('a numeric salary field with no currency signal anywhere flags instead of filling the figure', async () => {
    // The audited defect (old generic.ts desiredAnswer salary case): '80000' would have been
    // typed straight into this box on a posting of unknown currency.
    const el = genericField('What are your salary expectations?', 'input', 'number');
    const result = await runGeneric(ap(FIGURE_EUR));
    expect(el.value).toBe('');
    expect(result.skipped_reasons.some((r) => r.startsWith('salary question left for you'))).toBe(true);
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  });

  it('a label-stated range fills the median into a numeric field as a bare number', async () => {
    const el = genericField('Salary expectations (USD 90,000 - 110,000)', 'input', 'number');
    await runGeneric(ap(FIGURE_EUR));
    expect(el.value).toBe('100000');
  });

  it('a free-text salary field with no range gets the Negotiable sentence', async () => {
    const el = genericField('Desired salary', 'input', 'text');
    await runGeneric(ap(PROSE));
    expect(el.value).toBe('Negotiable, open to your standard intern rate');
  });

  it('a salary TEXTAREA is owned by the salary rule, never the AI essay drafter', async () => {
    // Before the branch, a salary question rendered as a textarea fell through to the drafter:
    // an LLM-drafted negotiating anchor in the student's name.
    const el = genericField('What are your salary expectations?', 'textarea');
    const drafted: string[] = [];
    await runGeneric(ap(PROSE), async (q) => {
      drafted.push(q);
      return 'A drafted essay that must never land here.';
    });
    expect(drafted).toEqual([]);
    expect(el.value).toBe('Negotiable, open to your standard intern rate');
  });
});
