import { describe, it, expect } from 'vitest';
import { gradeQuestion, gradeReviewReason, gradeSkipReason } from './grades';
import { skippedReasonsNeedReview } from '../autosubmit-gate';
import type { ApplicationProfile } from '../types';

const ap = (o: Partial<ApplicationProfile> = {}): ApplicationProfile => o as ApplicationProfile;

// R-005 (live QA 2026-07-16, Abound): a REQUIRED "What is your current grade average? (as a
// percentage, e.g. 68%)" and "What degree classification are you predicted..." were unfillable -
// nothing in the stack had ever handled a GPA.
//
// Mehek's real values: Computer Science, GPA 3.89 on a 4.0 scale, USC Viterbi, class of 2028.
const mehek = ap({ gpa: '3.89', gpa_scale: '4.0', major: 'Computer Science' });

describe('gradeQuestion: answering on our own scale', () => {
  it('fills a plain GPA question verbatim, with no review flag', () => {
    // Her real number on its own scale is not a derived claim, so it does not need her eyes.
    expect(gradeQuestion('what is your gpa?', mehek)).toEqual({ field: 'gpa', value: '3.89', needsReview: false });
    expect(gradeQuestion('cumulative gpa', mehek)).toEqual({ field: 'gpa', value: '3.89', needsReview: false });
  });

  it('treats "GPA (out of 4.0)" as a plain GPA question, not a conversion', () => {
    // Mentions a scale, but is still just asking for the GPA.
    const got = gradeQuestion('cumulative gpa (out of 4.0)', mehek);
    expect(got).toEqual({ field: 'gpa', value: '3.89', needsReview: false });
  });

  it('fills major', () => {
    expect(gradeQuestion('what is your major?', mehek)).toEqual({
      field: 'major', value: 'Computer Science', needsReview: false,
    });
    expect(gradeQuestion('field of study', mehek)?.value).toBe('Computer Science');
  });
});

describe('gradeQuestion: converting to a scale we do not store', () => {
  it('NEVER renders 3.89/4.0 as a linear percentage', () => {
    // The single most tempting wrong answer, called out by name in the issue register: naively
    // scaling 3.89/4.0 gives "97%", which misrepresents her standing to a real employer.
    const got = gradeQuestion('what is your current grade average? (as a percentage, e.g. 68%)', mehek);
    expect(got?.value).not.toBe('97');
    expect(got?.value).not.toBe('97.25');
    expect(got?.value).toBe('70'); // the First Class band floor
  });

  it('flags every converted answer for review, and discloses the mapping', () => {
    // This flag is the entire safety argument for converting at all (see R-004: deriving a claim
    // from adjacent profile data and shipping it as fact was rated CRITICAL). A converted value
    // that reaches an employer unreviewed is exactly that failure.
    const got = gradeQuestion('what is your current grade average? (as a percentage, e.g. 68%)', mehek);
    expect(got?.needsReview).toBe(true);
    expect(got && 'disclosure' in got && got.disclosure).toContain('3.89/4.0');
    expect(got && 'disclosure' in got && got.disclosure).toContain('not a direct percentage');
  });

  it('converts a predicted-classification question to the band name', () => {
    const got = gradeQuestion('what degree classification are you predicted?', mehek);
    expect(got?.value).toBe('First Class Honours');
    expect(got?.needsReview).toBe(true);
  });

  it('maps each band to its conventional UK floor, never above it', () => {
    // Under-claiming costs an interview; over-claiming is a false statement on an application.
    const at = (gpa: string) =>
      gradeQuestion('current grade average as a percentage', ap({ gpa, gpa_scale: '4.0' }))?.value;
    expect(at('4.0')).toBe('70');  // First
    expect(at('3.7')).toBe('70');  // First, boundary
    expect(at('3.69')).toBe('60'); // 2:1
    expect(at('3.3')).toBe('60');  // 2:1, boundary
    expect(at('3.29')).toBe('50'); // 2:2
    expect(at('2.7')).toBe('50');  // 2:2, boundary
    expect(at('2.69')).toBe('40'); // Third
    expect(at('2.0')).toBe('40');  // Third, boundary
  });

  it('refuses to convert from a scale it does not understand', () => {
    // A 10-point CGPA or a 20-point French scale has no mapping here. Guessing one would invent a
    // claim; leaving it blank asks a human.
    const tenPoint = ap({ gpa: '9.1', gpa_scale: '10' });
    expect(gradeQuestion('current grade average as a percentage', tenPoint)?.value).toBeUndefined();
    const noScale = ap({ gpa: '3.89' });
    expect(gradeQuestion('current grade average as a percentage', noScale)?.value).toBeUndefined();
  });

  it('refuses to convert a GPA below the lowest band rather than inventing one', () => {
    expect(gradeQuestion('grade average as a percentage', ap({ gpa: '1.4', gpa_scale: '4.0' }))?.value).toBeUndefined();
  });

  it('refuses to convert a non-numeric GPA', () => {
    expect(gradeQuestion('grade average as a percentage', ap({ gpa: 'first', gpa_scale: '4.0' }))?.value).toBeUndefined();
  });
});

describe('gradeQuestion: classification independent of stored value', () => {
  it('classifies the question even with nothing stored, so it is flagged not silently skipped', () => {
    // Same contract as linkQuestion / locationQuestion: "no GPA stored" and "not a GPA question"
    // must not collapse into one result, or the field is left blank with nobody told (R-002/R-008).
    expect(gradeQuestion('what is your gpa?', ap({}))).toEqual({ field: 'gpa', value: undefined, needsReview: false });
    expect(gradeQuestion('what is your major?', ap({}))).toEqual({ field: 'major', value: undefined, needsReview: false });
  });

  it('is not a grade question at all when nothing academic is named', () => {
    expect(gradeQuestion('why do you want to work here?', mehek)).toBeNull();
    expect(gradeQuestion('what is your phone number?', mehek)).toBeNull();
    expect(gradeQuestion('desired salary', mehek)).toBeNull();
  });
});

describe('gradeQuestion: labels that merely CONTAIN a grade-adjacent word', () => {
  // Every gradeQuestion match TERMINATES its block in the adapters, so a false positive is not a
  // mislabel: it swallows the question away from the essay drafter and the known-answer path, and
  // on the percent path it fills a number. These pin the matcher as default-deny (R-020's lesson).

  it('leaves an essay about "a major project" for the drafter', () => {
    // Matching these would leave the essay undrafted, with a bogus "major question left for you"
    // reason holding auto-submit. "major" the adjective is not "major" the noun about the student.
    expect(gradeQuestion('describe a major project you led', mehek)).toBeNull();
    expect(gradeQuestion('tell us about a major challenge you overcame', mehek)).toBeNull();
  });

  it('does not answer a travel-percentage question with a converted grade', () => {
    // The nastiest direction: with a GPA stored, the percent path FILLS. A loose percent match
    // writes "70" into a willingness-to-travel field - a flagged but real mis-fill.
    expect(gradeQuestion('what percentage of your time are you willing to travel?', mehek)).toBeNull();
    expect(gradeQuestion('are you comfortable travelling for work? (up to 50%)', mehek)).toBeNull();
  });

  it('does not read a numbered section heading as a degree classification', () => {
    expect(gradeQuestion('2.1 tell us why you want this role', mehek)).toBeNull();
  });

  it('does not read job-classification or honours-and-awards fields as a degree classification', () => {
    expect(gradeQuestion('desired job classification', mehek)).toBeNull();
    expect(gradeQuestion('honours and awards', mehek)).toBeNull();
  });

  it('still matches the same words in their academic positions', () => {
    expect(gradeQuestion('major *', mehek)?.value).toBe('Computer Science');
    expect(gradeQuestion('intended major', mehek)?.value).toBe('Computer Science');
    expect(gradeQuestion('what honours classification do you expect?', mehek)?.value).toBe('First Class Honours');
    expect(gradeQuestion('do you hold a first class degree?', mehek)?.value).toBe('First Class Honours');
    expect(gradeQuestion('what classification are you expecting? (e.g. 2:1)', mehek)?.value).toBe('First Class Honours');
  });
});

describe('the gate contract', () => {
  it('a converted grade HOLDS auto-submit', () => {
    // Built from the real builder: reword it out of REVIEW_FLAG and this fails HERE, rather than
    // letting a derived number about her academic record auto-submit to an employer unseen.
    const got = gradeQuestion('grade average as a percentage', mehek);
    const disclosure = got && 'disclosure' in got ? got.disclosure : '';
    expect(skippedReasonsNeedReview([gradeReviewReason('grade average', disclosure)])).toBe(true);
  });

  it('an unanswerable grade question HOLDS auto-submit', () => {
    expect(skippedReasonsNeedReview([gradeSkipReason('gpa', 'what is your gpa?')])).toBe(true);
    expect(skippedReasonsNeedReview([gradeSkipReason('major', 'what is your major?')])).toBe(true);
  });
});
