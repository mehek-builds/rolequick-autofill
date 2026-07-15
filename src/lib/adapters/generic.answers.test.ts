import { describe, it, expect } from 'vitest';
import { desiredAnswer, matchOption, eeoAnswer, workAuthWantYes, type Desired } from './generic';
// desiredAnswer/matchOption/eeoAnswer remain exported from generic; commitChoice (the shared
// radio/checkbox commit that every adapter now routes through) lives in ./shared/dom.
import type { ApplicationProfile } from '../types';

// The answer-resolution layer is pure (no DOM), and it is exactly the logic behind the
// EEO/work-auth radio bug: which answer a question resolves to, and which option text best
// satisfies it. These tests lock that behavior in so the shared-adapter refactor can't silently
// regress it.

const ap = (o: Partial<ApplicationProfile> = {}): ApplicationProfile => o as ApplicationProfile;
const opts = (...texts: string[]) => texts.map((text) => ({ text }));

describe('desiredAnswer', () => {
  it('maps work-authorization yes/no from the profile', () => {
    expect(desiredAnswer('are you legally authorized to work in the united states?', ap({ work_authorized: true }), {}))
      .toEqual({ mode: 'yes' });
    expect(desiredAnswer('legally authorized to work', ap({ work_authorized: false }), {}))
      .toEqual({ mode: 'no' });
  });

  it('maps sponsorship yes/no from the profile', () => {
    expect(desiredAnswer('will you now or in the future require sponsorship?', ap({ needs_sponsorship: true }), {}))
      .toEqual({ mode: 'yes' });
    expect(desiredAnswer('do you require visa sponsorship?', ap({ needs_sponsorship: false }), {}))
      .toEqual({ mode: 'no' });
  });

  it('inverts "without sponsorship" phrasing so a visa answer is not backwards', () => {
    // An OPT student authorized now but needing future sponsorship must answer NO to
    // "authorized to work WITHOUT sponsorship" - the plain rules used to answer Yes here.
    const opt = ap({ work_authorized: true, needs_sponsorship: true });
    expect(desiredAnswer('are you authorized to work without sponsorship?', opt, {})).toEqual({ mode: 'no' });
    expect(desiredAnswer('are you able to work without requiring sponsorship?', opt, {})).toEqual({ mode: 'no' });
    // A citizen who needs no sponsorship answers Yes to the same question.
    const citizen = ap({ work_authorized: true, needs_sponsorship: false });
    expect(desiredAnswer('are you authorized to work without sponsorship?', citizen, {})).toEqual({ mode: 'yes' });
  });

  it('answers an age-of-majority question yes', () => {
    expect(desiredAnswer('are you at least 18 years of age?', ap(), {})).toEqual({ mode: 'yes' });
  });

  it('declines EEO demographics when no preference is stored', () => {
    expect(desiredAnswer('what is your gender?', ap(), {})).toEqual({ mode: 'decline' });
    expect(desiredAnswer('race / ethnicity', ap(), {})).toEqual({ mode: 'decline' });
    expect(desiredAnswer('are you a protected veteran?', ap(), {})).toEqual({ mode: 'decline' });
    expect(desiredAnswer('do you have a disability?', ap(), {})).toEqual({ mode: 'decline' });
  });

  it('uses a stored EEO preference as a value when present', () => {
    expect(desiredAnswer('what is your gender?', ap(), { gender: 'Woman' })).toEqual({ mode: 'value', value: 'Woman' });
  });

  it('does not pull "do you identify as transgender?" into the gender-value rule', () => {
    // \bgender\b, not /gender/, so this distinct self-ID yes/no question we have no data for
    // is left blank rather than answered with the gender value.
    expect(desiredAnswer('do you identify as transgender?', ap(), { gender: 'Woman' })).toBeNull();
  });

  it('fills factual profile values', () => {
    expect(desiredAnswer('country of citizenship', ap({ citizenship: 'India' }), {})).toEqual({ mode: 'value', value: 'India' });
    expect(desiredAnswer('desired salary', ap({ desired_salary: '120000' }), {})).toEqual({ mode: 'value', value: '120000' });
    expect(desiredAnswer('date of birth', ap({ date_of_birth: '2005-01-01' }), {})).toEqual({ mode: 'value', value: '2005-01-01' });
  });

  it('never answers sensitive fields', () => {
    expect(desiredAnswer('social security number', ap({ work_authorized: true }), {})).toBeNull();
    expect(desiredAnswer("driver's license number", ap(), {})).toBeNull();
  });

  it('returns null for unrecognized questions', () => {
    expect(desiredAnswer('what is your favorite color?', ap(), {})).toBeNull();
  });
});

describe('eeoAnswer', () => {
  it('declines on empty/whitespace, values otherwise', () => {
    expect(eeoAnswer(undefined)).toEqual({ mode: 'decline' });
    expect(eeoAnswer('   ')).toEqual({ mode: 'decline' });
    expect(eeoAnswer('Woman')).toEqual({ mode: 'value', value: 'Woman' });
  });
});

describe('matchOption', () => {
  it('picks the decline option for a decline answer (the EEO default path)', () => {
    const o = opts('Male', 'Female', 'Non-binary', 'Decline to self-identify');
    expect(matchOption(o, { mode: 'decline' })?.text).toBe('Decline to self-identify');
    expect(matchOption(o, { mode: 'decline' } as Desired)).toBeTruthy();
  });

  it('returns null when no decline option exists rather than guessing', () => {
    expect(matchOption(opts('Male', 'Female'), { mode: 'decline' })).toBeNull();
  });

  it('picks the single Yes / No option', () => {
    const yn = opts('Yes', 'No');
    expect(matchOption(yn, { mode: 'yes' })?.text).toBe('Yes');
    expect(matchOption(yn, { mode: 'no' })?.text).toBe('No');
  });

  it('recognizes a negative option phrased without "no"', () => {
    const o = opts('I am a protected veteran', 'I am not a protected veteran', 'Decline to self-identify');
    expect(matchOption(o, { mode: 'no' })?.text).toBe('I am not a protected veteran');
    expect(matchOption(o, { mode: 'yes' })?.text).toBe('I am a protected veteran');
  });

  it('leaves ambiguous yes/no groups blank (two positives)', () => {
    expect(matchOption(opts('Yes, definitely', 'Yes, sometimes', 'No'), { mode: 'yes' })).toBeNull();
  });

  it('does not treat the decline option as the negative answer', () => {
    // "Decline" must not be picked as the "No" for a yes/no question.
    const o = opts('Yes', 'No', 'Prefer not to say');
    expect(matchOption(o, { mode: 'no' })?.text).toBe('No');
  });

  it('matches values exact-first, then substring', () => {
    expect(matchOption(opts('India', 'United States'), { mode: 'value', value: 'India' })?.text).toBe('India');
    expect(matchOption(opts('United States of America'), { mode: 'value', value: 'United States' })?.text)
      .toBe('United States of America');
  });

  it('does not mis-select on a coincidental letter run (word boundary, not bare substring)', () => {
    // "asian" is inside "Caucasian" and "male" is inside "Female": these must NOT be picked.
    expect(matchOption(opts('White/Caucasian', 'Black or African American', 'Hispanic'),
      { mode: 'value', value: 'Asian' })).toBeNull();
    expect(matchOption(opts('Female', 'Non-binary'), { mode: 'value', value: 'Male' })).toBeNull();
    // ...but a real exact/word-boundary match still works.
    expect(matchOption(opts('White/Caucasian', 'Asian', 'Hispanic'), { mode: 'value', value: 'Asian' })?.text).toBe('Asian');
    expect(matchOption(opts('Korea, Republic of', 'Japan'), { mode: 'value', value: 'Korea' })?.text)
      .toBe('Korea, Republic of');
  });

  it('returns null for a null desired or empty options', () => {
    expect(matchOption(opts('Yes', 'No'), null)).toBeNull();
    expect(matchOption([], { mode: 'yes' })).toBeNull();
  });
});

describe('workAuthWantYes', () => {
  it('answers plain work-auth and sponsorship questions directly', () => {
    expect(workAuthWantYes('legally authorized to work?', ap({ work_authorized: true }))).toBe(true);
    expect(workAuthWantYes('do you require sponsorship?', ap({ needs_sponsorship: true }))).toBe(true);
    expect(workAuthWantYes('do you require sponsorship?', ap({ needs_sponsorship: false }))).toBe(false);
  });

  it('inverts "without sponsorship" phrasing', () => {
    expect(workAuthWantYes('authorized to work without sponsorship?', ap({ work_authorized: true, needs_sponsorship: true }))).toBe(false);
    expect(workAuthWantYes('able to work without requiring sponsorship?', ap({ needs_sponsorship: false }))).toBe(true);
  });

  it('returns null when it is not a work-auth/sponsorship question or the profile cannot answer', () => {
    expect(workAuthWantYes('what is your favorite color?', ap({ work_authorized: true }))).toBeNull();
    expect(workAuthWantYes('do you require sponsorship?', ap())).toBeNull();
  });
});
