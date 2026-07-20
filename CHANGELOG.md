# Changelog

All notable changes to the Litos extension are documented here.

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
