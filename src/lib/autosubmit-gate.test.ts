import { describe, it, expect } from 'vitest';
import { skippedReasonsNeedReview } from './autosubmit-gate';

// Fix 5 of the completion audit: auto-submit must be HELD (hand back, do not start the countdown)
// whenever the adapter left a review-required item behind. These strings are the exact
// skipped_reasons the ATS adapters emit, so this locks the gate to real inputs.

describe('skippedReasonsNeedReview', () => {
  it('holds on an AI-drafted answer flagged for review', () => {
    // Every adapter unshifts this when it AI-drafts an open-ended answer.
    expect(skippedReasonsNeedReview(['2 open-ended answers AI-drafted, review before submitting'])).toBe(true);
  });

  it('holds on a never-fill / sensitive field left for the student', () => {
    expect(
      skippedReasonsNeedReview(['never-fill field (SSN/license/background-check consent), left for manual entry']),
    ).toBe(true);
  });

  it('holds on a question the adapter could not answer (no matching option / control)', () => {
    expect(skippedReasonsNeedReview(['EEO field: no matching option found, left blank'])).toBe(true);
    expect(skippedReasonsNeedReview(['Gender: no matching control, left blank'])).toBe(true);
    expect(skippedReasonsNeedReview(['city: no matching option found in the location picker, left blank'])).toBe(true);
  });

  it('holds on an ambiguous Yes/No the adapter would not guess', () => {
    expect(
      skippedReasonsNeedReview(['Sponsorship: no unambiguous Yes/No option among [J-1, F-1, None, Other], left blank']),
    ).toBe(true);
    expect(skippedReasonsNeedReview(['Work auth: no clean Yes/No control found, left blank'])).toBe(true);
  });

  it('holds on an agreement checkbox and on any dropdown/radio/checkbox left for you', () => {
    expect(skippedReasonsNeedReview(['agreement checkbox left for you to confirm: "I certify..."'])).toBe(true);
    expect(skippedReasonsNeedReview(['dropdown left for you: "Country"'])).toBe(true);
    expect(skippedReasonsNeedReview(['radio question left for you: "Are you a veteran?"'])).toBe(true);
  });

  it('holds on an autocomplete field left for manual selection', () => {
    expect(skippedReasonsNeedReview(['Referral source: autocomplete field, left for manual selection'])).toBe(true);
  });

  it('holds on any open-ended question left blank', () => {
    expect(skippedReasonsNeedReview(['open-ended question left blank: "Why do you want to work here?"'])).toBe(true);
  });

  it('does not hold on benign info skips or a clean fill', () => {
    // These are informational and do not need a human before submitting; the resume and required
    // fields are gated separately in content.ts (resumeMissing / hasEmptyRequiredFields).
    expect(skippedReasonsNeedReview([])).toBe(false);
    expect(skippedReasonsNeedReview(['email: not present in stored profile'])).toBe(false);
    expect(skippedReasonsNeedReview(['resume: no file input found on this form'])).toBe(false);
  });

  it('holds when any one reason in a longer list needs review', () => {
    expect(
      skippedReasonsNeedReview([
        'email: not present in stored profile',
        'Country: no matching option found, left blank',
      ]),
    ).toBe(true);
  });
});
