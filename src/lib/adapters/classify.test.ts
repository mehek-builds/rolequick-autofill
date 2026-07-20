import { describe, it, expect } from 'vitest';
import { desiredAnswer, classifyField, isLocationCommitmentQuestion } from './generic';
import type { ApplicationProfile } from '../types';

/* Two suites, and the order matters.
 *
 * The first is CHARACTERIZATION: it pins desiredAnswer's value-lookup branches exactly as they
 * behaved before classifyField existed. The shipped suite covered the denylist branches
 * (work-auth, sponsorship, EEO, age) thoroughly and these not at all, so refactoring them to share
 * one classifier would otherwise have been unprotected. These tests were written against the old
 * code and must keep passing unchanged.
 *
 * The second is the classifier itself, which harvest depends on.
 */

const FULL: ApplicationProfile = {
  phone: '+971 50 123 4567',
  address_city: 'Dubai',
  address_country: 'United Arab Emirates',
  linkedin_url: 'linkedin.com/in/mehekmandal',
  github_url: 'github.com/mehek-builds',
  portfolio_url: 'mehek.build',
  citizenship: 'India',
  date_of_birth: '25 Sep 2005',
  availability_date: 'June 2027',
  desired_salary: '80000',
  referral_source_default: 'Company website',
} as ApplicationProfile;

const EMPTY = {} as ApplicationProfile;
const NO_EEO: Record<string, string> = {};

describe('desiredAnswer value branches (characterization - behaviour predates classifyField)', () => {
  it('citizenship: an ADJECTIVE maps to its country and offers both spellings', () => {
    // NATIONALITY_TO_COUNTRY is keyed by the adjective (indian -> india), because that is the
    // direction that needs translating: a country dropdown lists "India" while the student may
    // have stored "Indian". Both are offered so a plain-text field can still take the raw value.
    const d = desiredAnswer('what is your nationality?', { ...FULL, citizenship: 'Indian' }, NO_EEO);
    expect(d).toEqual({ mode: 'oneof', values: ['india', 'Indian'] });
  });

  it('citizenship: a country name is already the dropdown spelling, so it passes through literally', () => {
    // Mehek's own stored value is "India", not "Indian" - so this, not the branch above, is the
    // path that ran on the live ANYbotics fill.
    expect(desiredAnswer('what is your nationality?', FULL, NO_EEO)).toEqual({
      mode: 'value',
      value: 'India',
    });
  });

  it('citizenship: an unmapped value falls back to a literal', () => {
    const d = desiredAnswer('country of citizenship', { ...FULL, citizenship: 'Wakanda' }, NO_EEO);
    expect(d).toEqual({ mode: 'value', value: 'Wakanda' });
  });

  it('country of residence is NOT the citizenship question', () => {
    const d = desiredAnswer('which country are you based in?', FULL, NO_EEO);
    expect(d).toEqual({ mode: 'value', value: 'United Arab Emirates' });
  });

  it('a question naming citizenship never answers with the residence country', () => {
    // The high-stakes split for any student whose citizenship differs from where they live -
    // which is the entire target user. "country of citizenship" contains "country", so without
    // the guard it would answer "United Arab Emirates" to a question about being Indian.
    const d = desiredAnswer('country of citizenship', FULL, NO_EEO);
    expect(d).toEqual({ mode: 'value', value: 'India' });
    expect(JSON.stringify(d)).not.toContain('Emirates');
  });

  it('referral source offers the default plus neutral fallbacks', () => {
    const d = desiredAnswer('how did you hear about this role?', FULL, NO_EEO);
    expect(d?.mode).toBe('oneof');
    expect((d as { values: string[] }).values[0]).toBe('Company website');
  });

  it('DOB and availability fill from the profile; salary no longer does bare (R-031)', () => {
    // The characterized salary behaviour - the bare stored figure for any salary label - IS
    // R-031's defect, so this one branch is deliberately superseded rather than preserved: a
    // bare figure now needs the label to name a currency matching desired_salary_currency
    // (adapters/salary.ts owns the rule, salary.test.ts pins it).
    expect(desiredAnswer('desired salary', FULL, NO_EEO)).toBeNull();
    expect(desiredAnswer('desired salary (aed)', { ...FULL, desired_salary_currency: 'AED' }, NO_EEO)).toEqual({
      mode: 'value',
      value: '80000',
    });
    expect(desiredAnswer('date of birth', FULL, NO_EEO)).toEqual({ mode: 'value', value: '25 Sep 2005' });
    expect(desiredAnswer('when can you start?', FULL, NO_EEO)).toEqual({ mode: 'value', value: 'June 2027' });
  });

  it('an empty profile yields null for every value branch', () => {
    // This is exactly why desiredAnswer cannot be the harvest classifier: on the empty profile
    // that IS the harvest case, it reports "not a salary question" and "no salary stored"
    // with the same value.
    expect(desiredAnswer('desired salary', EMPTY, NO_EEO)).toBeNull();
    expect(desiredAnswer('date of birth', EMPTY, NO_EEO)).toBeNull();
    expect(desiredAnswer('what is your nationality?', EMPTY, NO_EEO)).toBeNull();
    expect(desiredAnswer('this is not a field we know', EMPTY, NO_EEO)).toBeNull();
  });

  it('still refuses work-eligibility and EEO after the refactor', () => {
    expect(desiredAnswer('are you legally authorized to work in the us?', FULL, NO_EEO)).toBeNull();
    expect(desiredAnswer('will you require visa sponsorship?', FULL, NO_EEO)).toBeNull();
    expect(desiredAnswer('what is your gender?', FULL, NO_EEO)).toEqual({ mode: 'decline' });
  });

  it('still refuses never-fill fields', () => {
    expect(desiredAnswer('social security number', FULL, NO_EEO)).toBeNull();
  });
});

describe('classifyField (the harvest classifier)', () => {
  it('classifies a question independently of whether a value is stored', () => {
    // The property desiredAnswer lacks, and the whole reason this function exists. Same shape as
    // linkQuestion, whose doc comment records the bug that shipping the collapsed version caused.
    expect(classifyField('desired salary')).toBe('desired_salary');
    expect(classifyField('date of birth')).toBe('date_of_birth');
    expect(classifyField('what is your nationality?')).toBe('citizenship');
  });

  it('identifies the fields a real application teaches us', () => {
    expect(classifyField('phone number')).toBe('phone');
    expect(classifyField('', 'tel')).toBe('phone');
    expect(classifyField('city')).toBe('address_city');
    expect(classifyField('which country are you based in?')).toBe('address_country');
    expect(classifyField('linkedin profile')).toBe('linkedin_url');
    expect(classifyField('github')).toBe('github_url');
    expect(classifyField('portfolio')).toBe('portfolio_url');
    expect(classifyField('when can you start?')).toBe('availability_date');
    expect(classifyField('how did you hear about us?')).toBe('referral_source_default');
    expect(classifyField('what is your major?')).toBe('major');
    expect(classifyField('current grade average')).toBe('gpa');
  });

  // ---- R-004. The reason this codebase has a work-auth classifier at all. ----

  it('REFUSES work authorization, in every phrasing the shared classifier knows', () => {
    expect(classifyField('are you legally authorized to work in the united states?')).toBeNull();
    expect(classifyField('do you have the right to work in the country you are applying for?')).toBeNull();
    expect(classifyField('are you authorised to work without sponsorship?')).toBeNull();
    expect(classifyField('work authorization status')).toBeNull();
  });

  it('REFUSES sponsorship', () => {
    expect(classifyField('will you now or in the future require sponsorship?')).toBeNull();
    expect(classifyField('do you require visa sponsorship for employment?')).toBeNull();
  });

  it('REFUSES EEO / self-identification', () => {
    expect(classifyField('what is your gender?')).toBeNull();
    expect(classifyField('race / ethnicity')).toBeNull();
    expect(classifyField('are you hispanic or latino?')).toBeNull();
    expect(classifyField('protected veteran status')).toBeNull();
    expect(classifyField('do you have a disability?')).toBeNull();
    expect(classifyField('what is your age range?')).toBeNull();
  });

  it('REFUSES never-fill identity documents', () => {
    expect(classifyField('social security number')).toBeNull();
    expect(classifyField('ssn')).toBeNull();
    expect(classifyField("driver's license number")).toBeNull();
  });

  // The exact trap R-004 was: a work-auth question that CONTAINS a word we map elsewhere.
  it('a work-auth question mentioning "location" is refused, not read as a city', () => {
    expect(
      classifyField('are you legally authorized to work in the location where this role is based?'),
    ).toBeNull();
  });

  it('a work-auth question mentioning a country is refused, not read as residence', () => {
    expect(classifyField('are you authorized to work in the country where this role is based?')).toBeNull();
  });

  it('citizenship and residence stay distinct, both directions', () => {
    // ANYbotics/Lever, live 2026-07-16: nationality filled "India" correctly while the separate
    // permit question was correctly left blank. Both halves of that must hold.
    expect(classifyField('nationality')).toBe('citizenship');
    expect(classifyField('country of citizenship')).toBe('citizenship');
    expect(classifyField('where are you based?')).toBe('address_country');
    expect(classifyField('do you have a valid permit to work in switzerland?')).toBeNull();
  });

  it('returns null for anything it does not recognise, rather than guessing', () => {
    expect(classifyField('why do you want to work here?')).toBeNull();
    expect(classifyField('describe a hard problem you solved')).toBeNull();
    expect(classifyField('')).toBeNull();
  });
});

/* Merge guard. classifyField absorbed rules that landed on main while this branch was open, and
 * the refactor could have silently reverted them: the switch replaced an if-chain wholesale, so
 * any rule added to that chain in the meantime would have vanished with green tests. R-014 is the
 * one that did. These pin it through the NEW code path.
 *
 * R-014 facet b, live on Espa: "length or term/length of availability (10-14 weeks)" and "how long
 * are you available" both contain "availab", so a start-date rule running first poured her start
 * date into a duration question. Two questions, two fields, and the order between them is the fix. */
describe('classifyField preserves R-014 (term before start date)', () => {
  it('a duration question is availability_term, not availability_date', () => {
    expect(classifyField('length or term/length of availability (10-14 weeks)')).toBe('availability_term');
    expect(classifyField('how long are you available?')).toBe('availability_term');
    expect(classifyField('how many weeks are you available for the internship?')).toBe('availability_term');
  });

  it('a start-date question is still availability_date', () => {
    expect(classifyField('when can you start?')).toBe('availability_date');
    expect(classifyField('earliest possible starting date')).toBe('availability_date');
    expect(classifyField('when are you available to start?')).toBe('availability_date');
  });

  it('desiredAnswer routes each to its own field, not the other', () => {
    const ap = { availability_date: 'June 2027', availability_term: '14 weeks' } as ApplicationProfile;
    expect(desiredAnswer('length or term/length of availability (10-14 weeks)', ap, {})).toEqual({
      mode: 'value',
      value: '14 weeks',
    });
    expect(desiredAnswer('when can you start?', ap, {})).toEqual({ mode: 'value', value: 'June 2027' });
  });
});

/* R-039 (live 2026-07-18): the city/location matcher committed "Dubai" into two location-
 * COMMITMENT questions - Faire's in-office-commitment ask and Gemini's NYC-relocation ask. A
 * commitment question is a yes/no about willingness; a stored city answers neither. The veto
 * (isLocationCommitmentQuestion) requires question stem AND office/relocation vocabulary at once,
 * so every live residence phrasing this classifier was built against keeps classifying. */
describe('R-039 location-commitment veto', () => {
  // The two REAL labels, verbatim from the register (lowercased the way controlIdentity/
  // questionLabel hand labels to the classifier).
  const FAIRE =
    'this role will be in-office on a hybrid schedule, can you commit to being in-office three days per week at the sf office?';
  const GEMINI =
    "this role is required to be based near our new york city, ny office. are you open to relocating if you're not currently near nyc?";

  it('vetoes both live labels', () => {
    expect(isLocationCommitmentQuestion(FAIRE)).toBe(true);
    expect(isLocationCommitmentQuestion(GEMINI)).toBe(true);
  });

  it('the Gemini label no longer classifies as a city field (it contains "City")', () => {
    expect(classifyField(GEMINI)).toBeNull();
    expect(classifyField(FAIRE)).toBeNull();
  });

  it('desiredAnswer no longer answers a commitment question with her city', () => {
    const ap = { address_city: 'Dubai', address_country: 'United Arab Emirates' } as ApplicationProfile;
    expect(desiredAnswer(GEMINI, ap, {})).toBeNull();
  });

  it('a commitment question that lands on country vocabulary is vetoed too', () => {
    // Same disease, different unit: RESIDENCE_QUESTION's bare \bcountry\b alternative would
    // otherwise resolve this to address_country.
    expect(classifyField('do you commit to relocating to the country where our office is based?')).toBeNull();
  });

  it('every live residence phrasing keeps classifying exactly as before', () => {
    // The R-002 live set: these are the labels the location classifier was built against.
    expect(classifyField('location (city)*')).toBe('address_city');
    expect(classifyField("country you're currently residing in")).toBe('address_country');
    expect(classifyField('where are you currently located?')).toBe('address_city');
    expect(classifyField('current location')).toBe('address_city');
    expect(classifyField('where do you live?')).toBe('address_city');
    expect(classifyField('which city are you located in?')).toBe('address_city');
    // "where are you based" resolves to country first (RESIDENCE_QUESTION) - the documented
    // order. It carries the question stem but none of the veto vocabulary ("based" is deliberately
    // NOT vocabulary; the live labels supply "office"/"relocat" themselves).
    expect(classifyField('where are you based')).toBe('address_country');
  });

  it('stem without vocabulary, and vocabulary without stem, both stay un-vetoed', () => {
    expect(isLocationCommitmentQuestion('where are you currently located?')).toBe(false); // stem, no vocab
    expect(isLocationCommitmentQuestion('office address')).toBe(false); // vocab, no stem
    expect(isLocationCommitmentQuestion('office location')).toBe(false); // vocab, no stem
  });

  it('an office-commute commitment question is vetoed even when phrased with "commute"', () => {
    expect(isLocationCommitmentQuestion('can you commute to our office three days per week?')).toBe(true);
  });
});
