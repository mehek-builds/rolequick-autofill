# Changelog

All notable changes to the Litos extension are documented here.

## [0.4.9] - 2026-07-23

### Added

- Added password fill on Workday create-account forms. The password is derived per employer from a device-local secret, so the same account can be signed into again later, and no password is stored anywhere.
- Added bot-trap detection across every ATS, so hidden fields that exist only to catch automation are never written to.
- Added an explanation on the card when a password is deliberately left for the student, instead of leaving the box silently blank.

### Changed

- Changed the documented scope: the extension previously never touched password fields at all. It now fills them on Workday create-account forms only, and re-fills one on a sign-in form only for an account Litos itself created on this device. Every other case still leaves the password to the student, because submitting a wrong one locks a student out of their own account. Litos still never clicks Create Account and never completes email verification.

### Fixed

- Fixed the generic adapter treating a hidden bot-trap field as an ordinary question and filling it with the student's website, which marks the whole submission as automated traffic.
- Fixed password and its confirmation being counted as two filled fields instead of one.

## [0.4.8] - 2026-07-21

### Added

- Added changing, elapsed resume-generation phases and explicit submission states for waiting, confirmation, rejection, and unknown outcomes.
- Added inline resume review, persistent post-fill handoff, and a precise list of questions that still need the student.
- Added regression coverage for hostile portal metadata, retry-state precedence, submission-outcome precedence, and bounded monitoring.

### Fixed

- Fixed portal-controlled job titles and company names being interpreted as card markup.
- Fixed model-capacity retry messages being overwritten by the generic progress timer.
- Fixed submission monitoring repeatedly scanning the full portal without a deadline.
- Fixed Ashby portal styles collapsing Litos submission and review cards.
- Fixed resume-review focus and screen-reader announcements so keyboard users reach the replacement actions.
- Fixed completed review handoffs disappearing before the student could act on them.

## [0.4.7] - 2026-07-21

### Changed

- The production popup now ships only the Latin Geist variable font instead of bundling every language subset, cutting the packaged extension by about 48 kB while preserving system-font fallback for other scripts.

### Added

- Added a packaging regression test that prevents the full multi-subset font import from returning.

## [0.4.6] - 2026-07-20

### Added

- You now get consistent buttons, fields, headers, status indicators, and loading states throughout the extension.
- Contributors now have behavioral coverage for signup validation, asynchronous job detection, contact resolution, draft review, Gmail handoff, and outreach tracking.

### Changed

- Onboarding, application setup, job workflows, contact results, draft review, and outreach tracking now use a flatter layout that keeps the next action clear.
- Every popup screen and Chrome Web Store image now uses Geist and the Litos palette, with the interface rules recorded in `DESIGN.md`.
- Chrome Web Store screenshots now show the redesigned Litos workflow.

### Fixed

- Fields now keep their labels visible, keyboard focus is easier to see, switches have larger targets, headings are consistent, and status changes are announced more clearly.
- Tracking now handles unknown statuses safely, reports recent-outreach loading failures, and keeps Gmail launch errors from appearing as success.
- Production packages now default to the deployed Litos API, while development and QA builds can still override the backend.

### Removed

- Removed unused Inter assets, celebration confetti, stale animation tokens, and no-op visual styles to keep the production bundle focused.
