// Pure, DOM-free part of the auto-submit hold decision (Fix 5 of the completion audit). The
// adapters return a skipped_reasons list; some of those entries mean a human still has to look at
// the form before it is submitted. content.ts combines this with the DOM-dependent checks (a real
// final-submit button exists, no required field is empty, the tab is visible) and the AI-drafted
// count to decide whether to hold auto-submit. Kept here as a pure function so the classification
// can be unit-tested without a jsdom harness.

// A skip reason that still needs the student's eyes: an AI-drafted answer flagged for review, an
// agreement to confirm, a question the adapter could not answer (no matching option/control, no
// unambiguous or clean Yes/No), a never-fill or sensitive field, an autocomplete/dropdown left for
// manual selection, or any answer left blank. Conservative on purpose: when in doubt, HOLD.
const REVIEW_FLAG =
  /review before submitting|left for|left blank|no matching|no unambiguous|no clean|agreement|never-fill|autocomplete field/i;

export function skippedReasonsNeedReview(skippedReasons: string[]): boolean {
  return skippedReasons.some((r) => REVIEW_FLAG.test(r));
}
