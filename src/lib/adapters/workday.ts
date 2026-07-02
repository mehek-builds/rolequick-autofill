// Workday adapter (PRD-v2-resume-autofill.md Section 7, non-goal in Section 3: "No full
// Workday multi-page wizard automation in v2.0"). Detection-only - this triggers resume
// generation + the parallel outreach draft, but never touches the form itself. The student
// fills the Workday application by hand and attaches the generated resume manually.
//
// Section 12's resolved item 5 clarifies WHEN detection is allowed to fire: not during
// Workday's account-creation step, only once the student has an account and has actually
// landed on the real application-form page. Workday tenants vary widely in DOM structure
// (this is a hosted platform white-labeled per company, not a single shared template like
// Greenhouse/Lever/Ashby), so this heuristic is intentionally conservative and has NOT been
// live-tested against a real Workday tenant the way the other three adapters have - it
// should be treated as a starting point, not a verified integration, until run against a
// real posting.
//
// Account-creation heuristic: Workday's create-account/sign-in step always renders a
// password input and account-related copy; the real application form (after account
// creation) renders resume-upload and "My Experience"/"My Information" step markers instead.
// A page showing both (rare, but possible mid-transition) is treated as NOT yet a real
// application page - false negatives here are the safe failure mode (PRD's "detection
// gated on account already existing" - erring toward not firing beats firing too early).

function hasAccountCreationMarkers(): boolean {
  const hasPasswordField = !!document.querySelector('input[type="password"]');
  const bodyText = document.body.innerText.toLowerCase();
  const hasAccountCopy = /create account|create an account|sign in to your account|verify your email/.test(bodyText);
  return hasPasswordField || hasAccountCopy;
}

function hasApplicationFormMarkers(): boolean {
  const hasResumeUpload = !!document.querySelector(
    '[data-automation-id="file-upload-drop-zone"], [data-automation-id*="resumeUpload"], input[type="file"]',
  );
  const hasStepMarkers = !!document.querySelector(
    '[data-automation-id="myExperience"], [data-automation-id="myInformation"], [data-automation-id="pageHeader"]',
  );
  return hasResumeUpload || hasStepMarkers;
}

export function isWorkdayApplicationPage(): boolean {
  const h = window.location.hostname;
  if (!h.includes('myworkdayjobs.com') && !h.includes('workday.com')) return false;
  const path = window.location.pathname.toLowerCase();
  const looksLikeApplyUrl = path.includes('/apply') || (path.includes('/job/') && path.endsWith('/apply'));
  if (!looksLikeApplyUrl) return false;
  if (hasAccountCreationMarkers()) return false; // Section 12 item 5: never fire during account creation
  return hasApplicationFormMarkers();
}

export function extractWorkdayJdText(): string {
  // The job-posting page and the application-form page are often different URLs on
  // Workday; some tenants keep a summary of the role visible in a sidebar throughout
  // the apply flow (`jobPostingHeader`), but this isn't guaranteed across tenants, so
  // this falls back to whatever text is on the current page rather than failing closed.
  const desc =
    document.querySelector('[data-automation-id="jobPostingHeader"]')?.closest('div')?.textContent ??
    document.querySelector('[data-automation-id="jobPostingDescription"]')?.textContent;
  return (desc ?? document.body.innerText).trim().slice(0, 12000);
}
