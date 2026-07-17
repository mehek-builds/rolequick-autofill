import { describe, it, expect } from 'vitest';
import { desiredAnswer, linkQuestion, matchOption, eeoAnswer, WORK_ELIGIBILITY_QUESTION, type Desired } from './generic';
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

  it('never answers sponsorship from the profile (always-ask since 2026-07-16)', () => {
    expect(desiredAnswer('will you now or in the future require sponsorship?', ap({ needs_sponsorship: true }), {}))
      .toBeNull();
    expect(desiredAnswer('do you require visa sponsorship?', ap({ needs_sponsorship: false }), {}))
      .toBeNull();
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

  it('uses a stored EEO preference as a value when present, exact-match-only', () => {
    expect(desiredAnswer('what is your gender?', ap(), { gender: 'Woman' })).toEqual({ mode: 'value', value: 'Woman', exact: true });
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
    expect(eeoAnswer('Woman')).toEqual({ mode: 'value', value: 'Woman', exact: true });
  });

  // Mehek's ruling, 2026-07-17 (the R-018 judgement call). DO NOT drop `exact` to "make country
  // dropdowns and EEO share one rule" - the widening is correct for countries and wrong here, and
  // the exact-only tests below are what pin that difference.
  it('marks demographics exact-match-only so a near-miss is never committed', () => {
    expect(eeoAnswer('Male')).toEqual({ mode: 'value', value: 'Male', exact: true });
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
    // RESTORED after a code review found it had been deleted while the guard it pinned was also
    // dropped, leaving the bug live in 0.3.6. "asian" is inside "Caucasian" and "male" is inside
    // "Female": a bare .includes() matched exactly one option and committed it confidently, so an
    // Asian applicant got "White/Caucasian" ticked on a real EEO form and a male applicant got
    // "Female". Never delete this without restoring the boundary check in matchOption.
    expect(matchOption(opts('White/Caucasian', 'Black or African American', 'Hispanic'),
      { mode: 'value', value: 'Asian' })).toBeNull();
    expect(matchOption(opts('Female', 'Non-binary'), { mode: 'value', value: 'Male' })).toBeNull();
    // ...but a real exact/word-boundary match still works.
    expect(matchOption(opts('White/Caucasian', 'Asian', 'Hispanic'), { mode: 'value', value: 'Asian' })?.text).toBe('Asian');
    expect(matchOption(opts('Korea, Republic of', 'Japan'), { mode: 'value', value: 'Korea' })?.text)
      .toBe('Korea, Republic of');
  });

  // The other half of Mehek's R-018 ruling: word-boundary matching stops the "Male" -> "Female"
  // class of mis-select, but it does NOT stop "Male" -> "Male (cisgender)", which is a real word
  // -boundary hit on a genuinely different statement. `exact` is what stops that, and it is set
  // only for demographics (eeoAnswer), never for countries.
  it('commits an exact demographic option', () => {
    expect(matchOption(opts('Male', 'Female', 'Non-binary'), { mode: 'value', value: 'Male', exact: true })?.text)
      .toBe('Male');
  });

  it('leaves a demographic near-miss blank instead of widening to a variant', () => {
    // A word-boundary match, and still the wrong answer: "Male (cisgender)" is a different claim
    // about the student than "Male". Exact-only leaves it for them to answer themselves.
    expect(matchOption(opts('Male (cisgender)', 'Female (cisgender)', 'Non-binary'),
      { mode: 'value', value: 'Male', exact: true })).toBeNull();
    expect(matchOption(opts('Asian or Pacific Islander', 'White'),
      { mode: 'value', value: 'Asian', exact: true })).toBeNull();
  });

  it('keeps the country widening for non-exact values', () => {
    // Guards the ruling's other side: exact-only must not leak into country/citizenship matching,
    // where "Korea" -> "Korea, Republic of" is the helpful, correct answer.
    expect(matchOption(opts('Korea, Republic of', 'Japan'), { mode: 'value', value: 'Korea' })?.text)
      .toBe('Korea, Republic of');
  });

  it('leaves an ambiguous widening match for the student', () => {
    expect(matchOption(opts("Korea, Republic of", "Korea, Democratic People's Republic of"),
      { mode: 'value', value: 'Korea' })).toBeNull();
  });

  // The boundary guard above only changes behaviour in ONE shape: exact option ABSENT while a
  // single superstring option is present. These pin the full matrix so the next person can see
  // which outcomes are intended and which were previously safe only by accident.
  it('pins the full value-matching matrix around the boundary guard', () => {
    // exact present -> exact wins, boundary never consulted.
    expect(matchOption(opts('White/Caucasian', 'Asian', 'Hispanic'), { mode: 'value', value: 'Asian' })?.text).toBe('Asian');
    expect(matchOption(opts('Male', 'Female', 'Non-binary'), { mode: 'value', value: 'Male' })?.text).toBe('Male');
    // exact absent, superstring present but NOT on a word boundary -> null. This is the fix: it
    // used to return White/Caucasian.
    expect(matchOption(opts('White/Caucasian', 'Black or African American', 'Hispanic'),
      { mode: 'value', value: 'Asian' })).toBeNull();
    // two boundary hits -> ambiguous -> null. A trans-inclusive gender list lands here.
    expect(matchOption(opts('Female', 'Male (cisgender)', 'Male (transgender)'),
      { mode: 'value', value: 'Male' })).toBeNull();
    // taxonomy mismatch -> null rather than a guess.
    expect(matchOption(opts('Man', 'Woman', 'Decline to self-identify'), { mode: 'value', value: 'Male' })).toBeNull();
    // Single boundary hit -> commits. This is the intended widening, and it is what makes country
    // dropdowns work ("Korea" -> "Korea, Republic of", "United States" -> "United States of America").
    expect(matchOption(opts('Korea, Republic of', 'Japan'), { mode: 'value', value: 'Korea' })?.text)
      .toBe('Korea, Republic of');
    // KNOWN JUDGEMENT CALL, flagged in review: the same single-hit widening also commits here, so a
    // student whose stored gender is "Male" is answered "Male (cisgender)" on a form that offers no
    // plain "Male". Before the boundary guard this returned null, but only by accident: "female"
    // happens to contain "male", which made it look ambiguous. That accident is the very bug being
    // fixed, so it cannot be preserved on purpose without also re-breaking the Asian/Caucasian case.
    // Left committing to match the country behaviour above; revisit if EEO should be exact-only.
    expect(matchOption(opts('Female', 'Male (cisgender)'), { mode: 'value', value: 'Male' })?.text)
      .toBe('Male (cisgender)');
  });

  it('applies the answer rules regardless of label case (callers are not trusted to lowercase)', () => {
    expect(desiredAnswer('What Is Your Gender?', ap(), {})).toEqual({ mode: 'decline' });
    expect(desiredAnswer('Country Of Citizenship', ap({ citizenship: 'India' }), {}))
      .toEqual({ mode: 'value', value: 'India' });
    expect(desiredAnswer('Are You At Least 18 Years Of Age?', ap(), {})).toEqual({ mode: 'yes' });
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
  it('answers neither eligibility boolean, no matter what is stored', () => {
    // Work authorization became always-ask after live QA 2026-07-16 shipped a false declaration;
    // sponsorship followed the same day on Mehek's decision (same location-scoped mismatch).
    expect(desiredAnswer('legally authorized to work', ap({ work_authorized: true }), {})).toBeNull();
    expect(desiredAnswer('do you require visa sponsorship?', ap({ needs_sponsorship: false }), {})).toBeNull();
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

// Live QA 2026-07-16 (Xsolla/Lever): a "provide a LINK to your GitHub" question was answered with
// an AI-drafted prose paragraph. The resolver has to classify the QUESTION independently of
// whether a URL is stored, or "no URL" and "not a link question" collapse into the same value and
// the question falls through to the drafter, which is the bug.
describe('linkQuestion', () => {
  it('resolves the platform link questions to the stored url', () => {
    const p = ap({ linkedin_url: 'https://linkedin.com/in/mehek', github_url: 'https://github.com/mehek-builds', portfolio_url: 'https://mehek.dev' });
    expect(linkQuestion('linkedin profile', p)).toMatchObject({ field: 'linkedin', url: 'https://linkedin.com/in/mehek' });
    expect(linkQuestion('github link', p)).toMatchObject({ field: 'github', url: 'https://github.com/mehek-builds' });
    expect(linkQuestion('portfolio url', p)).toMatchObject({ field: 'portfolio', url: 'https://mehek.dev' });
  });

  it('still classifies a link question when NO url is stored (the drafter must never see it)', () => {
    // The old inline `linkTarget !== undefined` check returned undefined here, which fell through
    // to the AI-draft path and produced a prose paragraph in a URL field.
    const got = linkQuestion('please provide a link to your github', ap({}));
    expect(got).not.toBeNull();
    expect(got).toMatchObject({ field: 'github', url: undefined });
  });

  it('flags link-asking wording so a textarea can be filled, via asksForLink', () => {
    expect(linkQuestion('please provide a link to your github', ap({}))?.asksForLink).toBe(true);
    expect(linkQuestion('github url', ap({}))?.asksForLink).toBe(true);
    expect(linkQuestion('linkedin profile', ap({}))?.asksForLink).toBe(true);
  });

  it('does NOT flag an essay that merely mentions the platform, so it still reaches the drafter', () => {
    // "Tell us about your portfolio" is a real essay question. asksForLink=false keeps callers from
    // accepting its textarea, so it is drafted rather than answered with a bare URL.
    expect(linkQuestion('tell us about your portfolio', ap({}))?.asksForLink).toBe(false);
    expect(linkQuestion('what are you most proud of on your github?', ap({}))?.asksForLink).toBe(false);
  });

  it('is not a link question at all when no platform is named', () => {
    expect(linkQuestion('why do you want to work here?', ap({}))).toBeNull();
    expect(linkQuestion('what is your phone number?', ap({}))).toBeNull();
  });

  it('never claims a referral question, which names platforms among its OPTIONS', () => {
    // Adapters pass whole-container text as the label, so a referral question's option list lands
    // here. Four of the five adapters resolve links BEFORE known answers, so without this the
    // student's LinkedIn URL was written into "How did you hear about us?" instead of a referral.
    const p = ap({ linkedin_url: 'https://linkedin.com/in/mehek', portfolio_url: 'https://mehek.dev' });
    expect(linkQuestion('how did you hear about us? (e.g. linkedin, referral, job board)', p)).toBeNull();
    expect(linkQuestion('how did you hear about us? (e.g. company website, job board)', p)).toBeNull();
    expect(linkQuestion('referral source: linkedin / company website / other', p)).toBeNull();
    // ...and the referral question still resolves as a referral.
    expect(desiredAnswer('how did you hear about us? (e.g. linkedin, referral, job board)',
      ap({ referral_source_default: 'LinkedIn' }), {})).toMatchObject({ mode: 'oneof' });
  });
});

describe('WORK_ELIGIBILITY_QUESTION does not swallow a merely "sponsored" label', () => {
  it('leaves a referral question with a sponsored option answerable', () => {
    const label = 'how did you hear about this role? linkedin sponsored ad company website other';
    expect(WORK_ELIGIBILITY_QUESTION.test(label)).toBe(false);
    expect(desiredAnswer(label, ap({ referral_source_default: 'LinkedIn' }), {})).not.toBeNull();
  });

  it('ignores an unrelated sponsor mention', () => {
    expect(WORK_ELIGIBILITY_QUESTION.test('have you attended a sponsored event?')).toBe(false);
    expect(WORK_ELIGIBILITY_QUESTION.test('we are proud of our sponsorship of local charities')).toBe(false);
  });

  it('still catches every real sponsorship-of-work phrasing', () => {
    for (const l of [
      'will you now or in the future require immigration sponsorship?',
      'will you now or in the future require sponsorship?',
      'do you require visa sponsorship?',
      'do you need sponsor support to work in germany?',
      'are you able to work without sponsorship?',
      'are you authorized to work without requiring sponsorship?',
      'is sponsorship required for you to work here?',
    ]) {
      expect(WORK_ELIGIBILITY_QUESTION.test(l), l).toBe(true);
      expect(desiredAnswer(l, ap({ needs_sponsorship: false, work_authorized: true }), {}), l).toBeNull();
    }
  });
});

describe('desiredAnswer: "18" used for tenure is not an age-of-majority yes', () => {
  it('does not claim experience the student never stated', () => {
    expect(desiredAnswer('do you have 18 years of experience?', ap(), {})).toBeNull();
    expect(desiredAnswer('do you have 18+ months of experience?', ap(), {})).toBeNull();
    expect(desiredAnswer('do you have at least 18 months of relevant experience?', ap(), {})).toBeNull();
  });

  it('still answers a real age-of-majority question yes', () => {
    expect(desiredAnswer('are you at least 18 years of age?', ap(), {})).toEqual({ mode: 'yes' });
    expect(desiredAnswer('are you over 18?', ap(), {})).toEqual({ mode: 'yes' });
    expect(desiredAnswer('are you 18 years or older?', ap(), {})).toEqual({ mode: 'yes' });
    expect(desiredAnswer('you must be 18 years of age or older to apply', ap(), {})).toEqual({ mode: 'yes' });
  });
});
