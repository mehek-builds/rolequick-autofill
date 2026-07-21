// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  extractValidationErrors,
  mergeValidationReasons,
  validationErrorsToReasons,
} from './validation-authority';
import { selectNeedsYouReasons, skippedReasonsNeedReview } from './autosubmit-gate';

// Verbatim structure from the Five Rings refused submit (2026-07-18 live capture): a required
// transcript upload the pre-fill sweep never saw, a helper-text that names its field only through
// the id convention, and a select whose label carries the --error modifier.
const GREENHOUSE_REFUSAL = `
  <div id="upload-label-question_17808224008" class="label upload-label upload-label--error">
    Please upload your most recent transcript or grade report.<span class="required">*</span>
  </div>
  <p id="question_17808224008-error" class="helper-text helper-text--error" aria-live="polite">This field is required.</p>
  <label id="question_17808226008-label" for="question_17808226008"
    class="label select__label select__label--error select__label--outside-label">
    Please indicate your overall GPA.<span aria-hidden="true">*</span></label>
`;

// E-015's origin shape: Ashby's per-field refusal message inside the field entry (Notion GRC,
// six of these on the first submit). Message text carries the phrase; the entry label names it.
const ASHBY_REFUSAL = `
  <div class="ashby-application-form-field-entry">
    <label>Pronouns</label>
    <div class="_errorText_x1">Missing entry for required field</div>
  </div>
  <div class="ashby-application-form-field-entry">
    <label>How many prior internships have you completed?</label>
    <div role="alert">Missing entry for required field</div>
  </div>
`;

describe('extractValidationErrors', () => {
  it('reads the greenhouse refusal fixture: labeled errors, helper-text id convention, no dupes', () => {
    document.body.innerHTML = GREENHOUSE_REFUSAL;
    const errs = extractValidationErrors(document);
    const labels = errs.map((e) => e.label);
    expect(labels).toContain('Please upload your most recent transcript or grade report.');
    expect(labels).toContain('Please indicate your overall GPA.');
    // upload label appears via both the --error class and the helper id route - once in the output
    expect(labels.filter((l) => /transcript/.test(l))).toHaveLength(1);
  });

  it('reads ashby missing-entry messages and names the field from the entry label', () => {
    document.body.innerHTML = ASHBY_REFUSAL;
    const labels = extractValidationErrors(document).map((e) => e.label);
    expect(labels).toContain('Pronouns');
    expect(labels).toContain('How many prior internships have you completed?');
  });

  it('ignores container-sized error nodes (a corrections banner wraps fields, it is not a field)', () => {
    document.body.innerHTML = `<div class="form-error">Missing entry for required field ${'x'.repeat(300)}</div>`;
    expect(extractValidationErrors(document)).toHaveLength(0);
  });

  it('finds nothing on a clean form', () => {
    document.body.innerHTML = `<label class="label select__label" for="q1">School</label>`;
    expect(extractValidationErrors(document)).toHaveLength(0);
  });
});

describe('validation reasons through the existing pure gates', () => {
  const reasons = validationErrorsToReasons([
    { label: 'Pronouns', source: 'ashby-missing-entry' },
    { label: 'Degree type', source: 'ashby-missing-entry' },
  ]);

  it('trips the auto-submit hold and the card selector without modifying either', () => {
    expect(skippedReasonsNeedReview(reasons)).toBe(true);
    const selected = selectNeedsYouReasons(reasons);
    expect(selected).toHaveLength(2);
  });

  it('sorts ahead of non-required niceties under the cap, so the authority list survives truncation', () => {
    const mixed = [
      'agreement left for you: privacy policy',
      'no matching option: favourite colour',
      'autocomplete field left for manual selection: city',
      ...reasons,
      'no unambiguous Yes/No: newsletter',
    ];
    const selected = selectNeedsYouReasons(mixed, 4);
    expect(selected.slice(0, 2)).toEqual(reasons);
  });

  it('dedupes against heuristic reasons that already name the same field', () => {
    const existing = ['required open-ended question left blank: "pronouns"'];
    const merged = mergeValidationReasons(existing, reasons);
    expect(merged.filter((r) => /pronouns/i.test(r))).toHaveLength(1);
    expect(merged).toContain('required (form validation): "Degree type" left blank at submit');
  });
});
