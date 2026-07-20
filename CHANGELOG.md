# Changelog

All notable changes to the Litos extension are documented here.

## [0.4.5] - 2026-07-20

### Added

- Added a compact shared interface system with consistent buttons, fields, headers, status indicators, and loading states.
- Added behavioral tests for signup validation, asynchronous job detection, contact resolution, drafting, Gmail handoff, and outreach tracking.

### Changed

- Redesigned onboarding, application setup, job workflows, contact results, draft review, and outreach tracking around a flatter, quieter layout.
- Switched the extension to Geist, aligned every screen and store image to the Litos palette, and documented the design rules.
- Updated the Chrome Web Store screenshots to show the redesigned Litos workflow.

### Fixed

- Added persistent field labels, visible keyboard focus, larger switch hit targets, consistent heading structure, and clearer live-region announcements.
- Prevented unknown outreach statuses from crashing tracking, exposed recent-outreach loading failures, and stopped Gmail launch failures from showing false success.
- Kept production builds pointed at the deployed Litos API while documenting the development and QA override behavior.

### Removed

- Removed unused Inter assets, celebration confetti, stale animation tokens, and no-op visual styles.
