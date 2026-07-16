import { describe, it, expect } from 'vitest';
import { desiredAnswer, matchOption, WORK_ELIGIBILITY_QUESTION } from './generic';
import type { ApplicationProfile } from '../types';

// The ATS adapters (lever/greenhouse/ashby/workday/linkedin) now route their EEO, work-auth,
// sponsorship, and eligibility questions through the same pure engine the generic adapter uses:
// desiredAnswer(label, ap, eeo) resolves the answer, matchOption(options, desired) picks the
// option. Two things are specific to the ATS path and worth locking in here:
//   1. ATS labelTextFor() often returns the WHOLE question container's text (question stem plus
//      every visible option), not a clean <label>. The resolver must still classify it.
//   2. The combobox helpers read react-select option nodes whose text carries padding, newlines,
//      or zero-width prefixes. matchOption must normalize those before comparing.

const ap = (o: Partial<ApplicationProfile> = {}): ApplicationProfile => o as ApplicationProfile;
const opts = (...texts: string[]) => texts.map((text) => ({ text }));

describe('desiredAnswer on ATS full-block label text', () => {
  it('never answers work authorization, even when the label includes the option text', () => {
    // Work-auth questions are location-scoped; work_authorized is one global flag. Deriving an
    // answer shipped a false declaration on a real Lever form (live QA 2026-07-16), so the
    // resolver must leave these blank no matter what the profile says.
    expect(desiredAnswer('are you legally authorized to work in the us? yes no', ap({ work_authorized: true }), {}))
      .toBeNull();
  });

  it('never answers a combined authorized-without-sponsorship question from needs_sponsorship', () => {
    // The auth branch must win over the sponsorship branch for combined phrasings: this is the
    // exact question RoleQuick mis-filled on the Xsolla/Lever form.
    expect(
      desiredAnswer(
        'are you legally authorized to work without sponsorship in the location where this role is based? yes no',
        ap({ work_authorized: true, needs_sponsorship: true }),
        {},
      ),
    ).toBeNull();
  });

  it('never answers sponsorship either (always-ask since 2026-07-16, Mehek decision)', () => {
    expect(
      desiredAnswer(
        'will you now or in the future require immigration sponsorship? yes no',
        ap({ needs_sponsorship: false }),
        {},
      ),
    ).toBeNull();
  });

  it('declines EEO wrapped in a survey block, values it when a preference exists', () => {
    expect(desiredAnswer('gender please select an option decline to self-identify', ap(), {}))
      .toEqual({ mode: 'decline' });
    expect(desiredAnswer('gender please select an option decline to self-identify', ap(), { gender: 'Woman' }))
      .toEqual({ mode: 'value', value: 'Woman' });
  });

  it('answers an age-of-majority screening question inside block text', () => {
    expect(desiredAnswer('please confirm you are at least 18 years of age yes no', ap(), {}))
      .toEqual({ mode: 'yes' });
  });
});

describe('WORK_ELIGIBILITY_QUESTION classifier (the one shared by every adapter)', () => {
  it('matches labels whose phrases wrap across lines (raw textContent keeps internal whitespace)', () => {
    expect(WORK_ELIGIBILITY_QUESTION.test('are you legally\n  authorised to\n  work without sponsorship?')).toBe(true);
    expect(WORK_ELIGIBILITY_QUESTION.test('legally  authorized\tto work')).toBe(true);
  });

  it('matches both spellings and the common phrasings', () => {
    expect(WORK_ELIGIBILITY_QUESTION.test('are you authorised to work in the united kingdom?')).toBe(true);
    expect(WORK_ELIGIBILITY_QUESTION.test('work authorisation status')).toBe(true);
    expect(WORK_ELIGIBILITY_QUESTION.test('do you have the right to work in ireland?')).toBe(true);
    expect(WORK_ELIGIBILITY_QUESTION.test('Are You Legally Authorized To Work In The US?')).toBe(true);
  });

  it('matches plain sponsorship questions too (always-ask since 2026-07-16)', () => {
    expect(WORK_ELIGIBILITY_QUESTION.test('will you now or in the future require visa sponsorship?')).toBe(true);
    expect(WORK_ELIGIBILITY_QUESTION.test('do you need sponsor support to work in germany?')).toBe(true);
  });

  it('does not swallow unrelated questions', () => {
    expect(WORK_ELIGIBILITY_QUESTION.test('what is your desired salary?')).toBe(false);
    expect(WORK_ELIGIBILITY_QUESTION.test('are you at least 18 years of age?')).toBe(false);
  });
});

describe('matchOption on combobox option text', () => {
  it('matches a decline option that carries newlines and padding', () => {
    const o = opts('  Male ', '\n Female \n', '  Decline to self-identify  ');
    expect(matchOption(o, { mode: 'decline' })?.text).toBe('  Decline to self-identify  ');
  });

  it('matches yes/no options with a react-select zero-width prefix', () => {
    const o = opts('​Yes', '​No');
    expect(matchOption(o, { mode: 'yes' })?.text).toBe('​Yes');
    expect(matchOption(o, { mode: 'no' })?.text).toBe('​No');
  });

  it('matches a city value by substring against a padded option label', () => {
    const o = opts(' Los Angeles, CA, United States ', ' San Francisco, CA ');
    expect(matchOption(o, { mode: 'value', value: 'Los Angeles' })?.text)
      .toBe(' Los Angeles, CA, United States ');
  });

  it('leaves a visa-type list blank for a boolean sponsorship answer', () => {
    // "None/J1/F1/Other" has no single clean yes/no option, so the adapters skip rather than guess.
    expect(matchOption(opts('J-1', 'F-1', 'None', 'Other'), { mode: 'no' })).toBeNull();
  });
});
