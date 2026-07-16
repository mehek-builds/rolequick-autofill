import { describe, it, expect } from 'vitest';
import { desiredAnswer, matchOption, eeoAnswer, type Desired } from './generic';
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
  it('never answers work authorization from the profile (location-scoped question, global flag)', () => {
    // Live QA 2026-07-16: deriving this from work_authorized shipped a false "authorized without
    // sponsorship" declaration on a real Lever form. Always-ask, regardless of the stored value.
    expect(desiredAnswer('are you legally authorized to work in the united states?', ap({ work_authorized: true }), {}))
      .toBeNull();
    expect(desiredAnswer('legally authorized to work', ap({ work_authorized: false }), {}))
      .toBeNull();
    expect(desiredAnswer('do you have the right to work in the uk?', ap({ work_authorized: true }), {}))
      .toBeNull();
  });

  it('maps sponsorship yes/no from the profile', () => {
    expect(desiredAnswer('will you now or in the future require sponsorship?', ap({ needs_sponsorship: true }), {}))
      .toEqual({ mode: 'yes' });
    expect(desiredAnswer('do you require visa sponsorship?', ap({ needs_sponsorship: false }), {}))
      .toEqual({ mode: 'no' });
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

  it('returns null for a null desired or empty options', () => {
    expect(matchOption(opts('Yes', 'No'), null)).toBeNull();
    expect(matchOption([], { mode: 'yes' })).toBeNull();
  });
});

// ── Audit fixes ───────────────────────────────────────────────────────────────
// Regression coverage for the completion-flow bugs fixed in this branch.

describe('desiredAnswer: unset eligibility is left blank, never answered "No" (fix #1)', () => {
  it('leaves work authorization blank when the field is null (the DB value for "unset")', () => {
    // GET /profile/application returns null (not undefined) for a boolean the student never set.
    // The old `!== undefined` guard let null through and answered "No" (null is falsy).
    expect(desiredAnswer('are you legally authorized to work in the united states?', ap({ work_authorized: null as unknown as boolean }), {})).toBeNull();
  });
  it('leaves work authorization blank when the field is undefined', () => {
    expect(desiredAnswer('legally authorized to work', ap(), {})).toBeNull();
  });
  it('leaves sponsorship blank when the field is null', () => {
    expect(desiredAnswer('do you require visa sponsorship?', ap({ needs_sponsorship: null as unknown as boolean }), {})).toBeNull();
  });
  it('still answers a set sponsorship boolean, never work authorization', () => {
    // Work authorization became always-ask after live QA 2026-07-16 shipped a false declaration;
    // sponsorship remains answerable because its stored value is what the student chose to state.
    expect(desiredAnswer('legally authorized to work', ap({ work_authorized: true }), {})).toBeNull();
    expect(desiredAnswer('do you require visa sponsorship?', ap({ needs_sponsorship: false }), {})).toEqual({ mode: 'no' });
  });
});

describe('desiredAnswer: age-of-majority phrasing (fix #15)', () => {
  it('does not answer a negatively-phrased age question "yes"', () => {
    expect(desiredAnswer('are you under 18 years of age?', ap(), {})).toBeNull();
    expect(desiredAnswer('are you younger than 18?', ap(), {})).toBeNull();
  });
  it('still answers an affirmative age-of-majority question "yes"', () => {
    expect(desiredAnswer('are you at least 18 years of age?', ap(), {})).toEqual({ mode: 'yes' });
    expect(desiredAnswer('are you over 18?', ap(), {})).toEqual({ mode: 'yes' });
    // "18 years or older" carries none of at-least/over/older-than, so it needs the guarded
    // "18 years" alternative (restored after review); the "under" guard still blocks the negatives.
    expect(desiredAnswer('are you 18 years or older?', ap(), {})).toEqual({ mode: 'yes' });
    expect(desiredAnswer('you must be 18 years of age or older to apply', ap(), {})).toEqual({ mode: 'yes' });
  });
});

describe('matchOption: broadened decline wordings (fix #10)', () => {
  it('matches "Choose not to disclose" as a decline option', () => {
    expect(matchOption(opts('Male', 'Female', 'Choose not to disclose'), { mode: 'decline' })?.text)
      .toBe('Choose not to disclose');
  });
  it('matches "I do not wish to identify" as a decline option', () => {
    expect(matchOption(opts('Yes', 'No', 'I do not wish to identify'), { mode: 'decline' })?.text)
      .toBe('I do not wish to identify');
  });
});

describe('desiredAnswer: citizenship and residence country are never conflated (fix: address_country separation)', () => {
  it('answers a "citizen of?" question with citizenship, not the residence country', () => {
    // The residence rule's bare \bcountry\b used to swallow this phrasing (it carries no literal
    // "citizenship"/"nationality" token) and fill address_country into a citizenship field - the
    // exact high-stakes mis-fill for students whose citizenship differs from where they live.
    expect(desiredAnswer('what country are you a citizen of?', ap({ citizenship: 'India', address_country: 'United States' }), {}))
      .toEqual({ mode: 'value', value: 'India' });
    // "which country" also appears here, but the citizenship rule must win over the residence rule.
    expect(desiredAnswer('of which country are you a citizen?', ap({ citizenship: 'India', address_country: 'United States' }), {}))
      .toEqual({ mode: 'value', value: 'India' });
  });

  it('maps a nationality-adjective citizenship to its country for a citizenship dropdown', () => {
    expect(desiredAnswer('country of citizenship', ap({ citizenship: 'Indian', address_country: 'United States' }), {}))
      .toEqual({ mode: 'oneof', values: ['india', 'Indian'] });
  });

  it('leaves a citizenship question blank when citizenship is unset (never falls back to residence)', () => {
    expect(desiredAnswer('country of citizenship', ap({ address_country: 'United States' }), {})).toBeNull();
    expect(desiredAnswer('what country are you a citizen of?', ap({ address_country: 'United States' }), {})).toBeNull();
  });

  it('still fills the residence country for location questions and bare "country"', () => {
    expect(desiredAnswer('which country do you intend to work from?', ap({ address_country: 'United States' }), {}))
      .toEqual({ mode: 'value', value: 'United States' });
    expect(desiredAnswer('country of residence', ap({ address_country: 'United States' }), {}))
      .toEqual({ mode: 'value', value: 'United States' });
    expect(desiredAnswer('country', ap({ citizenship: 'India', address_country: 'United States' }), {}))
      .toEqual({ mode: 'value', value: 'United States' });
  });
});
