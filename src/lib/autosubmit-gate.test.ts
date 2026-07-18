import { describe, it, expect } from 'vitest';
import { selectNeedsYouReasons, skippedReasonsNeedReview } from './autosubmit-gate';
import { linkSkipReason, locationSkipReason, unreadableQuestionSkipReason, workEligibilitySkipReason } from './adapters/generic';
import { resumeFetchSkipReason } from './resume-fetch';

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

  it('holds on a work-eligibility question left for the student (live QA 2026-07-16 fix)', () => {
    // Work-auth AND sponsorship questions are never auto-answered anymore; the adapters emit
    // exactly this reason, and auto-submit must not fire while the question sits unanswered.
    expect(
      skippedReasonsNeedReview([
        'work-eligibility question left for you: "Are you legally authorized to work in the locat"',
      ]),
    ).toBe(true);
  });

  it('pins the shared reason builder to the gate: workEligibilitySkipReason must always hold', () => {
    // The hold rests on this string contract. If someone rewords workEligibilitySkipReason so it
    // stops matching REVIEW_FLAG, auto-submit could fire with a legal question blank; this test
    // is the tripwire.
    expect(skippedReasonsNeedReview([workEligibilitySkipReason('do you require sponsorship?')])).toBe(true);
  });

  it('pins the shared reason builder to the gate: linkSkipReason must always hold', () => {
    // Same tripwire, for link questions we could not fill: a link field left blank must hand back
    // rather than auto-submit an incomplete application.
    expect(skippedReasonsNeedReview([linkSkipReason('please provide a link to your github')])).toBe(true);
  });

  it('holds on any open-ended question left blank', () => {
    expect(skippedReasonsNeedReview(['open-ended question left blank: "Why do you want to work here?"'])).toBe(true);
  });

  it('pins the shared reason builder to the gate: an undraftable question must always hold (R-006)', () => {
    // Built from the real builder rather than hand-typed, so rewording it without checking
    // REVIEW_FLAG fails HERE instead of letting a form auto-submit with a required essay blank.
    expect(skippedReasonsNeedReview([unreadableQuestionSkipReason()])).toBe(true);
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

  it('pins the shared reason to the gate: resumeFetchSkipReason must always hold (R-041)', () => {
    // The hold rests on this string contract: "could not be attached" is what REVIEW_FLAG
    // matches. If someone rewords resumeFetchSkipReason without checking the gate, auto-submit
    // could fire on an application whose resume never downloaded - the exact silent failure
    // R-041 exists to prevent - so this test is the tripwire.
    expect(skippedReasonsNeedReview([resumeFetchSkipReason])).toBe(true);
  });

  it('holds on a location question left unanswered (R-002)', () => {
    // This coupling is the entire point of the R-002 fix and it is invisible in either file alone:
    // locationSkipReason's "left for" wording is what REVIEW_FLAG matches. Build the strings with
    // the real builder rather than hand-typing them, so rewording the reason without checking the
    // gate fails HERE instead of silently letting a form with an empty required country field
    // auto-submit. Both variants must hold: no value stored, and a picker we could not drive.
    expect(skippedReasonsNeedReview([locationSkipReason('country', 'Country', 'no-value')])).toBe(true);
    expect(skippedReasonsNeedReview([locationSkipReason('city', 'Location (City)', 'no-value')])).toBe(true);
    expect(skippedReasonsNeedReview([locationSkipReason('country', "Location* / Country you're currently residing in", 'no-option')])).toBe(true);
    expect(skippedReasonsNeedReview([locationSkipReason('state', 'State / Province', 'no-option')])).toBe(true);
  });
});

describe('selectNeedsYouReasons', () => {
  it('keeps the reasons that need a human and drops the resume line and benign info', () => {
    expect(
      selectNeedsYouReasons([
        'resume: no generated resume file available',
        'email: not present in stored profile',
        'open-ended question left blank: "Why here?"',
        'agreement checkbox left for you to confirm: "I certify..."',
      ]),
    ).toEqual([
      'open-ended question left blank: "Why here?"',
      'agreement checkbox left for you to confirm: "I certify..."',
    ]);
  });

  it('sorts a REQUIRED blank ahead of the cap so it can never fall off the card (R-033)', () => {
    // The live card capped its list at 4; a required blank sitting fifth would silently vanish
    // and the card would read as complete over an empty required control. Required-first plus the
    // cap makes that impossible.
    const reasons = [
      'dropdown left for you: "Country"',
      'radio question left for you: "Veteran status"',
      'agreement checkbox left for you to confirm: "I certify..."',
      'open-ended question left blank: "Anything else?"',
      'required open-ended question left blank: "Please share 3-5 sentences explaining..."',
    ];
    const picked = selectNeedsYouReasons(reasons);
    expect(picked).toHaveLength(4);
    expect(picked[0]).toMatch(/^required open-ended question left blank/);
  });

  it('keeps the adapter emission order among equals (stable sort, no reshuffling)', () => {
    const reasons = [
      'dropdown left for you: "Country"',
      'radio question left for you: "Veteran status"',
    ];
    expect(selectNeedsYouReasons(reasons)).toEqual(reasons);
  });

  it('surfaces the R-032 verify-pass reason (a value the page did not keep)', () => {
    expect(
      selectNeedsYouReasons(['first name left for you: the page did not keep the value RoleQuick wrote']),
    ).toEqual(['first name left for you: the page did not keep the value RoleQuick wrote']);
  });

  it('surfaces the R-041 download-failure reason while still dropping the adapter resume line', () => {
    // Both can appear on the same failed fill: the adapter reports the absence it saw
    // ("resume: ..."), content.ts adds the why (the download failed). The card's one-line
    // resume warning covers the former; only the latter belongs under "Still needs you".
    expect(
      selectNeedsYouReasons([
        'resume: no generated resume file available',
        resumeFetchSkipReason,
      ]),
    ).toEqual([resumeFetchSkipReason]);
  });
});
