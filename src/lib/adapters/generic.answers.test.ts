import { describe, it, expect } from 'vitest';
import { ageOfMajorityAnswer, desiredAnswer, isDraftableQuestion, linkQuestion, locationQuestion, matchOption, eeoAnswer, namesTheCompanySite, unreadableQuestionSkipReason, WORK_ELIGIBILITY_QUESTION, type Desired } from './generic';
import { firstNonEmptyText } from './shared/dom';
import { skippedReasonsNeedReview } from '../autosubmit-gate';
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
  it('never globalizes work authorization across jurisdictions', () => {
    for (const label of [
      'are you legally authorized to work in the united states?',
      'do you have the right to work in the UK?',
      'are you authorized to work in Germany?',
      'are you legally permitted to work in the UAE?',
    ]) {
      expect(desiredAnswer(label, ap({ work_authorized: true, needs_sponsorship: false }), {}), label).toBeNull();
      expect(desiredAnswer(label, ap({ work_authorized: false, needs_sponsorship: true }), {}), label).toBeNull();
    }
  });

  it('never answers sponsorship from global profile values', () => {
    expect(desiredAnswer('will you now or in the future require sponsorship?', ap({ needs_sponsorship: true }), {}))
      .toBeNull();
    expect(desiredAnswer('do you require visa sponsorship?', ap({ needs_sponsorship: false }), {}))
      .toBeNull();
  });

  it('requires a valid DOB before answering an explicit age threshold', () => {
    expect(desiredAnswer('are you at least 18 years of age?', ap(), {})).toBeNull();
  });

  it('leaves privacy consent and location commitments to the current application', () => {
    expect(
      desiredAnswer('Do you consent to Brex processing your personal information for the purpose of assessing your candidacy?', ap(), {}),
    ).toBeNull();
    expect(
      desiredAnswer("Please review and acknowledge Cloudflare's Candidate Privacy Policy.", ap(), {}),
    ).toBeNull();
    expect(
      desiredAnswer('this role will be in-office on a hybrid schedule, can you commit to being in-office three days per week?', ap(), {}),
    ).toBeNull();
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
    expect(desiredAnswer('date of birth', ap({ date_of_birth: '2005-01-01' }), {})).toEqual({ mode: 'value', value: '2005-01-01' });
  });

  it('never fills an applicant salary expectation', () => {
    expect(desiredAnswer('desired salary', ap({ desired_salary: '120000' }), {})).toBeNull();
    expect(
      desiredAnswer('desired salary (usd)', ap({ desired_salary: '120000', desired_salary_currency: 'USD' }), {}),
    ).toBeNull();
    expect(
      desiredAnswer('expected salary (usd 90,000 - 110,000)', ap({ desired_salary_currency: 'EUR' }), {}),
    ).toBeNull();
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
    expect(desiredAnswer('Are You At Least 18 Years Of Age?', ap(), {})).toBeNull();
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
  it('leaves eligibility blank even when legacy global booleans exist', () => {
    expect(desiredAnswer('legally authorized to work', ap({ work_authorized: true }), {})).toBeNull();
    expect(desiredAnswer('legally authorized to work', ap({ work_authorized: false }), {})).toBeNull();
    expect(desiredAnswer('do you require visa sponsorship?', ap({ needs_sponsorship: false }), {})).toBeNull();
    expect(desiredAnswer('do you require visa sponsorship?', ap({ needs_sponsorship: true }), {})).toBeNull();
  });
});

describe('desiredAnswer: age-of-majority phrasing (fix #15)', () => {
  it('does not answer a negatively-phrased age question "yes"', () => {
    expect(desiredAnswer('are you under 18 years of age?', ap(), {})).toBeNull();
    expect(desiredAnswer('are you younger than 18?', ap(), {})).toBeNull();
  });
  it('uses exact calendar boundaries only with a valid DOB', () => {
    const now = new Date('2026-08-09T23:59:59Z');
    expect(ageOfMajorityAnswer('are you at least 18 years of age?', '2008-08-09', now)).toEqual({ mode: 'yes' });
    expect(ageOfMajorityAnswer('are you at least 18 years of age?', '2008-08-10', now)).toEqual({ mode: 'no' });
    expect(ageOfMajorityAnswer('are you at least 18 years of age?', undefined, now)).toBeNull();
    expect(ageOfMajorityAnswer('are you at least 18 years of age?', '2008-02-30', now)).toBeNull();
    expect(ageOfMajorityAnswer('have you reached the age of majority?', '2000-01-01', now)).toBeNull();
  });
});

/* The extension and the backend are two readers of the same form, and the 18+ attestation is the
 * one question where disagreeing is a false legal declaration rather than a blank field. These
 * pin the extension's copy to the backend's (student-outreach-backend src/lib/questionDiscovery.ts,
 * ageAttestationAnswer): each case below is one the two answered DIFFERENTLY before this change. */
describe('ageOfMajorityAnswer: parity with the backend attestation rule', () => {
  const NOW = new Date('2026-08-09T23:59:59Z');
  const ADULT_DOB = '2005-09-25'; // 20 on NOW
  const MINOR_DOB = '2012-01-01'; // 14 on NOW

  it('inverts the minor framing instead of going silent on it', () => {
    // Previously every "under"/"younger than" phrasing was dropped on the floor, so the backend
    // answered No and the extension left the same radio blank.
    expect(ageOfMajorityAnswer('are you under 18 years of age?', ADULT_DOB, NOW)).toEqual({ mode: 'no' });
    expect(ageOfMajorityAnswer('are you younger than 18?', ADULT_DOB, NOW)).toEqual({ mode: 'no' });
    expect(ageOfMajorityAnswer('are you under 18 years of age?', MINOR_DOB, NOW)).toEqual({ mode: 'yes' });
    expect(ageOfMajorityAnswer('are you 18 years of age or older?', MINOR_DOB, NOW)).toEqual({ mode: 'no' });
  });

  it('recognises the phrasings the extension pattern used to miss entirely', () => {
    for (const label of [
      'are you 18 or older?',
      'are you over 18?',
      'are you older than 18?',
      'i confirm i am eighteen years of age',
      'at the time of application, are you 18+ years of age?',
    ]) {
      expect(ageOfMajorityAnswer(label, ADULT_DOB, NOW), label).toEqual({ mode: 'yes' });
    }
  });

  it('reads the free-text date shape /profile/harvest stores', () => {
    // AutofillSetupScreen writes ISO, but a harvested date arrives as the form wrote it. Before
    // this only strict ISO was read, so a harvested profile was refused while the backend answered.
    for (const stored of ['25 Sep 2005', '25 September, 2005', 'Sep 25, 2005', 'September 25 2005']) {
      expect(ageOfMajorityAnswer('are you at least 18 years of age?', stored, NOW), stored)
        .toEqual({ mode: 'yes' });
    }
  });

  it('treats an unreadable stored value exactly like an absent one', () => {
    for (const stored of [
      '2008-02-30',        // the ISO parser rolls this over to 1 March 2008 rather than erroring
      'sometime in 2005',  // `new Date` invents 1 January 2005 out of this
      '2005',
      'Sep 2005',
      '09/08/2005',        // 8 September or 9 August: picking one is a guess
      '2044-01-01',        // not yet born
      '1880-01-01',        // older than anyone alive
    ]) {
      expect(ageOfMajorityAnswer('are you at least 18 years of age?', stored, NOW), stored).toBeNull();
    }
  });

  it('answers only the 18 threshold, the one the backend answers', () => {
    // The old rule accepted any threshold from 16 to 25 and answered "no" here while the backend
    // refused the label outright.
    expect(ageOfMajorityAnswer('are you at least 21 years of age?', ADULT_DOB, NOW)).toBeNull();
    expect(ageOfMajorityAnswer('are you at least 16 years of age?', ADULT_DOB, NOW)).toBeNull();
  });

  it('never reads 18 as a duration, however the duration is counted', () => {
    for (const label of [
      'do you have 18+ months of experience?',
      'have you completed at least 18 credits?',
      'have you completed at least 18 units of coursework?',
      'can you work at least 18 hours per week?',
      'have you had 18 years of continuous employment?',
    ]) {
      expect(ageOfMajorityAnswer(label, ADULT_DOB, NOW), label).toBeNull();
    }
  });

  it('leaves a demographic age bucket to the EEO rule even when it lists an 18+ option', () => {
    // Adapters pass whole-container text as the label, so the option list lands here. Answering
    // "Yes" to a self-identification bucket is not an attestation, it is a wrong answer.
    expect(ageOfMajorityAnswer('what is your age? 18+ 25-34 35-44', ADULT_DOB, NOW)).toBeNull();
    expect(ageOfMajorityAnswer('age range 18+ 25-34', ADULT_DOB, NOW)).toBeNull();
    expect(desiredAnswer('what is your age? 18+ 25-34 35-44', ap({ date_of_birth: ADULT_DOB }), {}))
      .toEqual({ mode: 'decline' });
  });

  it('answers the attestation from the profile through desiredAnswer', () => {
    expect(desiredAnswer('are you 18 years or older?', ap({ date_of_birth: ADULT_DOB }), {}))
      .toEqual({ mode: 'yes' });
    expect(desiredAnswer('are you 18 years or older?', ap(), {})).toBeNull();
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

  it('fills current residence but not a future intended work location', () => {
    expect(desiredAnswer('which country do you intend to work from?', ap({ address_country: 'United States' }), {}))
      .toBeNull();
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

describe('referral source never invents a channel the profile does not store', () => {
  // "How did you hear about us?" is a factual claim about THIS application. With
  // referral_source_default unset - which is how the owner's own profile ships - the answer used
  // to walk "company website" -> "company careers" -> "careers page" -> "company site" before
  // reaching "other", so every fill asserted she came through the careers page, including on
  // postings found via a job board or a referral. Nothing in the profile supports that sentence.
  const REFERRAL_LABEL = 'how did you hear about us?';
  const INVENTED = ['company website', 'company careers', 'careers page', 'company site'];

  const valuesOf = (d: Desired): string[] => (d as { values: string[] }).values;

  it('claims nothing at all when no referral source is stored', () => {
    expect(desiredAnswer(REFERRAL_LABEL, ap(), {})).toBeNull();
  });

  it('names no company-website channel on any unset-profile referral phrasing', () => {
    for (const label of [
      'how did you hear about us?',
      'how did you first hear about this role?',
      'referral source',
      'how did you hear about this opportunity? linkedin / indeed / other',
    ]) {
      expect(desiredAnswer(label, ap(), {}), label).toBeNull();
    }
  });

  it('leaves the question for the student when the form has no "Other" option', () => {
    // The live shape of the bug: a form that lists real channels and no catch-all. Before, the
    // first fallback landed "Company website" confidently; now nothing matches, and the caller's
    // "dropdown left for you" reason is what the student sees instead.
    const options = opts('LinkedIn', 'Indeed', 'Company website', 'Employee referral');
    expect(matchOption(options, desiredAnswer(REFERRAL_LABEL, ap(), {}))).toBeNull();
  });

  it('holds the auto-submit countdown on the reason that replaces the invented answer', () => {
    // The refusal is only safe because the caller's skip reason carries "left for", the phrase
    // autosubmit-gate's REVIEW_FLAG matches. Asserted here so a reworded reason cannot quietly
    // turn a flagged referral question into a silent blank that auto-submits.
    expect(skippedReasonsNeedReview([`dropdown left for you: "${REFERRAL_LABEL}"`])).toBe(true);
    expect(skippedReasonsNeedReview([`radio question left for you: "${REFERRAL_LABEL}"`])).toBe(true);
  });

  it('leaves an exact "Other" option unanswered when no source is stored', () => {
    const options = opts('LinkedIn', 'Job board', 'Other');
    expect(matchOption(options, desiredAnswer(REFERRAL_LABEL, ap(), {}))).toBeNull();
    expect(skippedReasonsNeedReview([`dropdown left for you: "${REFERRAL_LABEL}"`])).toBe(true);
  });

  it('treats an empty, whitespace, or zero-width stored value as unset rather than as an answer', () => {
    // The zero-width case is not academic: values[0] is what adapters type into a combobox as the
    // typeahead query, so a lone U+200B surviving the guard gets typed into a live form field.
    for (const blank of ['', '   ', '​', ' ​ ﻿ ', ' ']) {
      expect(desiredAnswer(REFERRAL_LABEL, ap({ referral_source_default: blank }), {}), JSON.stringify(blank))
        .toBeNull();
    }
  });

  it('holds the historical company-site default without packet-specific acquisition evidence', () => {
    for (const source of ['Company website', 'Website', 'Web site', 'Careers', 'Careers page']) {
      expect(desiredAnswer(REFERRAL_LABEL, ap({ referral_source_default: source }), {}), source).toBeNull();
      expect(matchOption(opts(source, 'Other'), desiredAnswer(REFERRAL_LABEL,
        ap({ referral_source_default: source }), {})), source).toBeNull();
    }
  });

  it('answers a stored referral source with the value the student wrote, first', () => {
    expect(valuesOf(desiredAnswer(REFERRAL_LABEL, ap({ referral_source_default: 'LinkedIn' }), {}))[0])
      .toBe('LinkedIn');
  });

  // Second half of the same defect: a stored value used to license the WHOLE fallback list, so a
  // student who found the job on LinkedIn and met a form without a LinkedIn option was answered
  // "Company website" anyway. Same invented fact as the unset branch, only harder to see.
  it('never widens a stored channel into a different channel', () => {
    for (const source of ['LinkedIn', 'Indeed', 'A friend', 'University career fair', 'Glassdoor']) {
      const values = valuesOf(desiredAnswer(REFERRAL_LABEL, ap({ referral_source_default: source }), {}));
      expect(values, source).toEqual([source]);
      for (const claim of INVENTED) expect(values, `${source} -> ${claim}`).not.toContain(claim);
    }
  });

  it('leaves a stored channel the form does not list for the student, rather than substituting one', () => {
    const desired = desiredAnswer(REFERRAL_LABEL, ap({ referral_source_default: 'LinkedIn' }), {});
    expect(matchOption(opts('Indeed', 'Company website', 'Employee referral'), desired)).toBeNull();
    // With a catch-all present the answer is "Other", which is true by construction: the channel
    // she stored is not on this list.
    expect(matchOption(opts('Indeed', 'Company website', 'Other'), desired)?.text).toBe('Other');
    // And the form that does list it still gets the real answer.
    expect(matchOption(opts('LinkedIn', 'Indeed', 'Other'), desired)?.text).toBe('LinkedIn');
  });

  it('recognises company-site wordings without treating recognition as submission evidence', () => {
    // These all claim the employer's own site. The matrix varies owner nouns, possessives,
    // punctuation, articles, and surface nouns so a finite phrase set cannot accidentally pass a
    // new portal spelling through exact-match or Other.
    for (const source of [
      'Company website',
      'Careers page',
      "The company's careers page",
      'The company’s careers page',
      '  The company´s careers page  ',
      'Company Website.',
      'careers-page',
      'company  website',
      'career site',
      'Employer careers page',
      'The employer’s careers page',
      "The employer's career-site",
      'Company careers portal',
      'Company hiring portal',
      'Organization jobs site',
      'Organisation career webpage',
      'Job posting on company website',
    ]) {
      expect(namesTheCompanySite(source), source).toBe(true);
      expect(desiredAnswer(REFERRAL_LABEL, ap({ referral_source_default: source }), {}), source).toBeNull();
    }
    // Near misses, not far ones. Each is a word away from the allowlist, so any reimplementation
    // as a loose regex (/website|careers?/) fails here rather than silently widening "my portfolio
    // website" into a claim that she came through the employer's careers page.
    for (const source of [
      'LinkedIn', 'Indeed', 'A friend', 'Job board', 'Recruiter', 'Twitter',
      'Website', 'web site', 'careers',
      'personal website', 'my website', 'portfolio website',
      'company blog', 'LinkedIn company page', 'recruiter website',
      'University careers page', 'Handshake career portal', 'Employer referral',
    ]) {
      expect(namesTheCompanySite(source), source).toBe(false);
    }
  });

  it('fails closed before exact or Other matching for every ambiguous employer-site source', () => {
    for (const source of [
      'Website',
      'Website!',
      'Careers',
      'Employer careers page',
      'The employer’s careers page',
      'Company careers portal',
    ]) {
      const desired = desiredAnswer(REFERRAL_LABEL, ap({ referral_source_default: source }), {});
      expect(desired, source).toBeNull();
      expect(matchOption(opts(source, 'Other'), desired), source).toBeNull();
    }
  });

  it('keeps genuine explicit non-site sources eligible for exact and truthful catch-all matching', () => {
    for (const source of ['LinkedIn', 'Indeed', 'Recruiter', 'Employee referral', 'University career fair']) {
      const desired = desiredAnswer(REFERRAL_LABEL, ap({ referral_source_default: source }), {});
      expect(matchOption(opts(source, 'Other'), desired)?.text, source).toBe(source);
      expect(matchOption(opts('Not listed', 'Other'), desired)?.text, source).toBe('Other');
    }
  });

  // The catch-all is a MATCHING RULE, not a value, and this matrix is why. Passing the literal
  // string 'other' as a oneof value routes it through matchOption's word-boundary widening, where
  // \bother\b hits "Other referral" and "Other job board" just as readily as "Other" - and a
  // single hit commits, filled, with no skip reason. Measured on the first version of this fix.
  it('accepts only a catch-all that names no channel', () => {
    const desired = desiredAnswer(REFERRAL_LABEL, ap({ referral_source_default: 'Source not listed' }), {});
    for (const [options, expected] of [
      [['LinkedIn', 'Other'], 'Other'],
      [['LinkedIn', 'Other (please specify)'], 'Other (please specify)'],
      [['LinkedIn', 'Other, please specify'], 'Other, please specify'],
      [['LinkedIn', 'Other - please specify'], 'Other - please specify'],
      [['LinkedIn', 'Other:'], 'Other:'],
      [['LinkedIn', 'Others'], 'Others'],
      // Every one of these NAMES A CHANNEL. Selecting one is the invention, wearing "Other" as a
      // prefix. They must go to the student instead.
      [['LinkedIn', 'Indeed', 'Other job board'], null],
      [['LinkedIn', 'Employee referral', 'Other referral'], null],
      [['Company website', 'Other job boards'], null],
      [['Job boards (Other)', 'LinkedIn'], null],
      [['LinkedIn', 'Other social media'], null],
      [['LinkedIn', 'Other source'], null],
      [['Indeed', 'Other: job board'], null],
      [['Indeed', 'Other - employee referral'], null],
      [['Indeed', 'Other (job board)'], null],
      [['Indeed', 'Other, recruiter website'], null],
      // No catch-all at all, and ambiguity, both go to the student.
      [['LinkedIn', 'Indeed', 'Company website', 'Employee referral'], null],
      [['Other', 'Other (please specify)'], null],
    ] as Array<[string[], string | null]>) {
      expect(matchOption(opts(...options), desired)?.text ?? null, options.join(' | ')).toBe(expected);
    }
  });

  it('keeps the catch-all behind a stored value, and never ahead of it', () => {
    const desired = desiredAnswer(REFERRAL_LABEL, ap({ referral_source_default: 'LinkedIn' }), {});
    expect(matchOption(opts('LinkedIn', 'Other'), desired)?.text).toBe('LinkedIn');
    expect(matchOption(opts('Indeed', 'Other'), desired)?.text).toBe('Other');
    // The stored value must not reach a channel-naming "Other ..." either.
    expect(matchOption(opts('Indeed', 'Other job board'), desired)).toBeNull();
  });

  it('never widens ambiguous stored words into an employer-site claim', () => {
    for (const source of ['Website', 'Web site', 'Careers']) {
      const desired = desiredAnswer(REFERRAL_LABEL, ap({ referral_source_default: source }), {});
      expect(desired, source).toBeNull();
      for (const option of ['Company website', 'Company web site', 'Company careers', 'Careers page']) {
        expect(matchOption(opts(option), desired), `${source} -> ${option}`).toBeNull();
      }
    }
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
      'is sponsorship required for you to work here?',
    ]) {
      expect(WORK_ELIGIBILITY_QUESTION.test(l), l).toBe(true);
      expect(desiredAnswer(l, ap({ needs_sponsorship: false, work_authorized: true }), {}), l).toBeNull();
    }
    for (const l of [
      'are you able to work without sponsorship?',
      'are you authorized to work without requiring sponsorship?',
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

  it('does not infer a real age-of-majority answer without DOB', () => {
    expect(desiredAnswer('are you at least 18 years of age?', ap(), {})).toBeNull();
    expect(desiredAnswer('are you over 18?', ap(), {})).toBeNull();
    expect(desiredAnswer('are you 18 years or older?', ap(), {})).toBeNull();
    expect(desiredAnswer('you must be 18 years of age or older to apply', ap(), {})).toBeNull();
  });
});

describe('locationQuestion', () => {
  // Live QA 2026-07-16: a required location field was left blank on 3 of 12 real forms while being
  // filled on a 4th from the same profile. These are the verbatim labels from those forms.
  const full = ap({ address_city: 'Dubai', address_state: 'Dubai', address_country: 'United Arab Emirates' });

  it('classifies the three labels that were left blank live', () => {
    // Monzo (Greenhouse): "Location (City)*" - names the unit, so city.
    expect(locationQuestion('location (city)', full)).toEqual({ field: 'city', value: 'Dubai' });
    // Global Relay (Greenhouse embed): a bare "Country*".
    expect(locationQuestion('country', full)).toEqual({ field: 'country', value: 'United Arab Emirates' });
    // ElevenLabs (Ashby): the label that broke the old `/^(location|city)\b/` rule two ways - it
    // does not START with "location", and the adapter had no country branch at all.
    expect(locationQuestion("location* / country you're currently residing in", full)).toEqual({
      field: 'country',
      value: 'United Arab Emirates',
    });
  });

  it('still classifies a bare "Location" as city, which is what Abound filled correctly', () => {
    expect(locationQuestion('location', full)).toEqual({ field: 'city', value: 'Dubai' });
  });

  it('classifies the question even when the profile has no value stored', () => {
    // The property that makes this a fix rather than a wider regex: "no country stored" and "not a
    // location question" must NOT collapse into the same result. A classified question with an
    // undefined value still terminates the block (blank + flagged, which holds auto-submit); the
    // old inline rules required the value to be present to even recognise the question, so an unset
    // field was left blank silently and bounced at submit.
    expect(locationQuestion('country', ap({}))).toEqual({ field: 'country', value: undefined });
    expect(locationQuestion('location (city)', ap({}))).toEqual({ field: 'city', value: undefined });
  });

  it('never answers a work-eligibility question that happens to name a country (R-004)', () => {
    // These name a country but are always-ask LEGAL questions. Answering them from address_country
    // is exactly the CRITICAL failure that shipped a false declaration on a real Lever form: a
    // global profile flag mapped onto a location-scoped legal question. They must fall through to
    // WORK_ELIGIBILITY_QUESTION, so locationQuestion must not claim them.
    expect(locationQuestion('which country are you authorized to work in?', full)).toBeNull();
    expect(locationQuestion('are you legally authorized to work in canada?', full)).toBeNull();
    expect(locationQuestion('do you require sponsorship to work in the country where this role is based?', full)).toBeNull();
  });

  it('never answers a citizenship question with the residence country', () => {
    // A student whose citizenship differs from where she lives is the whole reason for the split.
    expect(locationQuestion('what country are you a citizen of?', full)).toBeNull();
    expect(locationQuestion('country of citizenship', full)).toBeNull();
    expect(locationQuestion('nationality', full)).toBeNull();
  });

  it('prefers the most specific unit when a label names more than one', () => {
    // A city-first order would try to put "Dubai" into a country picker and match nothing.
    expect(locationQuestion('city / country', full)?.field).toBe('country');
    expect(locationQuestion('state / province', full)?.field).toBe('state');
  });

  it('is not a location question at all when nothing locational is named', () => {
    expect(locationQuestion('why do you want to work here?', full)).toBeNull();
    expect(locationQuestion('what is your phone number?', full)).toBeNull();
    expect(locationQuestion('desired salary', full)).toBeNull();
  });

  it('routes through desiredAnswer too, so an unwired adapter still resolves the value', () => {
    expect(desiredAnswer('country', full, {})).toEqual({ mode: 'value', value: 'United Arab Emirates' });
    expect(desiredAnswer('location (city)', full, {})).toEqual({ mode: 'value', value: 'Dubai' });
    // Unset stays null in desiredAnswer (unchanged fall-through); only adapters calling
    // locationQuestion directly get the flag-instead-of-silence guarantee.
    expect(desiredAnswer('country', ap({}), {})).toBeNull();
    // And the R-004 guard holds through this path as well.
    expect(desiredAnswer('are you legally authorized to work in canada?', full, {})).toBeNull();
  });
});

describe('firstNonEmptyText (R-006 label fall-through)', () => {
  // The bug this kills: `??` treats an existing-but-empty source as a real answer, because "" is
  // non-null. shared/dom already warned about this form on radioOptionsIn ("`||` not `??`") after
  // it caused the canonical radio non-fill, but it survived in three adapters' question readers.
  it('falls through a source that exists but renders empty', () => {
    expect(firstNonEmptyText('', 'Why Abound?')).toBe('why abound?');
    expect(firstNonEmptyText('   ', '\n\t ', 'Why Abound?')).toBe('why abound?');
  });

  it('is the difference between reading the question and reading nothing', () => {
    // Verbatim shape of the live failure: an Ashby entry whose <legend> exists but renders blank,
    // with the real question in the <label> beneath it. The old `if (legend) return ... ?? ''`
    // resolved to "" here and never looked at the label.
    const emptyLegend = '';
    const realLabel = 'Why Abound?';
    expect(firstNonEmptyText(emptyLegend, realLabel)).toBe('why abound?');
    // What `??` did instead, spelled out so the regression is unmistakable.
    expect(emptyLegend ?? realLabel).toBe('');
  });

  it('prefers the first source that has real text', () => {
    expect(firstNonEmptyText('Why Cohere?', 'ignored')).toBe('why cohere?');
  });

  it('normalizes whitespace and lowercases, so a wrapped label still matches the label regexes', () => {
    expect(firstNonEmptyText('  Location\n  (City)  ')).toBe('location (city)');
  });

  it('returns empty only when every source is genuinely empty', () => {
    expect(firstNonEmptyText(undefined, null, '', '   ')).toBe('');
  });
});

describe('isDraftableQuestion (R-006 drafter guard)', () => {
  it('refuses an unreadable label, so the drafter is never asked to answer nothing', () => {
    // The backend requires question: z.string().min(1), so "" is a guaranteed 400 -> null draft ->
    // a REQUIRED essay left blank. That is the last link in R-006's chain.
    expect(isDraftableQuestion('')).toBe(false);
    expect(isDraftableQuestion('   ')).toBe(false);
    expect(isDraftableQuestion('?')).toBe(false);
  });

  it('allows a real question', () => {
    expect(isDraftableQuestion('why abound?')).toBe(true);
    expect(isDraftableQuestion('what makes you a good fit?')).toBe(true);
  });

  it('holds auto-submit when it declines to draft', () => {
    // "left for" is the contract with the gate: an essay we would not draft must hand back rather
    // than let a blank required field auto-submit.
    expect(unreadableQuestionSkipReason()).toContain('left for');
  });
});
