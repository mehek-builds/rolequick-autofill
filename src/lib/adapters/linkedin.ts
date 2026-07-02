// LinkedIn Easy Apply adapter (PRD-v2-resume-autofill.md Section 7). Detection-only, same
// posture as Workday: LinkedIn's anti-automation stance (v0 PRD Section 8's ban-risk
// discipline - "read only what the user is actively viewing, no automation of anything
// LinkedIn would flag") means this triggers resume generation + the parallel outreach draft
// but never writes into LinkedIn's own Easy Apply form fields. The student fills the modal
// by hand and attaches the generated resume manually, same as the LinkedIn resume-upload
// step Easy Apply already has built in.
//
// Detection reuses the exact modal selectors content.ts's watchLinkedInEasyApply() already
// uses for the v0 outreach flow (both need "is the Easy Apply modal open right now").

const EASY_APPLY_MODAL_SELECTORS = [
  '[data-test-modal-id="easy-apply-modal"]',
  '[aria-label="Easy Apply"]',
  '.jobs-easy-apply-modal',
  '[class*="easy-apply-modal"]',
];

export function isLinkedInApplicationPage(): boolean {
  if (!window.location.hostname.includes('linkedin.com')) return false;
  return EASY_APPLY_MODAL_SELECTORS.some((sel) => !!document.querySelector(sel));
}

export function extractLinkedInJdText(): string {
  // The Easy Apply modal sits on top of the job posting, not inside it - the description
  // is still in the underlying page, not the modal.
  const desc =
    document.querySelector('.jobs-description__content')?.textContent ??
    document.querySelector('#job-details')?.textContent ??
    document.querySelector('[class*="jobs-description"]')?.textContent;
  return (desc ?? document.body.innerText).trim().slice(0, 12000);
}
