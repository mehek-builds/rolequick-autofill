# Litos: Tailored Resumes and Application Autofill

Every job application makes you re-enter the same information and rewrite your resume for the role. Litos is a Chrome extension that autofills applications with AI-tailored resumes and essays generated from your profile.

Install: https://chromewebstore.google.com/detail/rolequick-tailored-resume/bdbedbmkjpfioknfpmhookefabipjaad

## System architecture

The extension is a thin, careful client. Every piece of AI generation happens on the Litos backend; the extension detects, orchestrates, fills, and guards.

```
        ┌───────────────────────────────────────────────────────────────┐
 POPUP  │  React 18 + Tailwind (src/entrypoints/popup, src/components)   │
        │  onboarding · autofill setup · find people · draft · tracking │
        └───────────────▲───────────────────────────────────────────────┘
                        │ chrome.runtime messages + chrome.storage.local
        ┌───────────────┴───────────────────────────────────────────────┐
 BG     │  Background service worker (src/entrypoints/background.ts)     │
 WORKER │  message router · holds auth token · all backend fetches       │
        └───────────────▲───────────────────────────────────────────────┘
                        │ REST (Bearer JWT), VITE_API_BASE
        ┌───────────────┴───────────────────────────────────────────────┐
 BACKEND│  Litos backend API (separate repo, not in this codebase)   │
        │  /auth · /profile · /resolve · /draft · /resume/generate ·    │
        │  /application/answer · /track · /autofill/event               │
        └───────────────────────────────────────────────────────────────┘

        ┌───────────────────────────────────────────────────────────────┐
 CONTENT│  Content scripts injected on job pages (src/entrypoints)       │
 SCRIPTS│  content.ts   → on-page cards, submit watch, auto-submit ring  │
        │  persistent-badge.ts → floating launcher                      │
        └───────────────▲───────────────────────────────────────────────┘
                        │ imports
        ┌───────────────┴───────────────────────────────────────────────┐
 FILL   │  Per-ATS adapters (src/lib/adapters/*.ts)                      │
 LAYER  │  lever · greenhouse · ashby · workday · linkedin · generic    │
        │        │                                                       │
        │        ├─ shared/dom.ts   combobox + commit + native-set       │
        │        └─ generic.ts      pure answer engine (reused by all)   │
        └───────────────────────────────────────────────────────────────┘
```

Data flows two ways. When a student lands on a posting, a content script detects the job and offers cards; on "Yes," it asks the background worker to generate a tailored resume and pull the stored profile, then hands both to the matching adapter, which fills the form in place. Separately, the popup and background worker resolve contacts and draft outreach through the same backend. The content script never holds the auth token (it lives in `chrome.storage.local`, reachable only from the background worker), so every network call that needs auth is routed through a `chrome.runtime` message.

---

## The full stack

| Layer | Technologies |
|-------|--------------|
| **Extension framework** | [WXT](https://wxt.dev) 0.20.26 (`wxt.config.ts`), Manifest V3, `@wxt-dev/module-react`, entrypoint conventions for background / content / popup, `wxt zip` packaging (Chrome + Firefox targets) |
| **Language / UI** | TypeScript 5.4.5, React 18.3.1, react-dom 18.3.1, JSX via `react-jsx`, `@types/chrome` |
| **Styling** | Tailwind CSS 3.4.4 with a compact utility design system in `src/components/ui.tsx`, PostCSS 8.4.38, autoprefixer, Geist Variable via `@fontsource-variable/geist` |
| **Content-script fill engine** | Native-setter value writes (`Object.getOwnPropertyDescriptor(proto,'value').set`), click-first `commitChoice` for controlled radios, real `PointerEvent`/`MouseEvent`/`KeyboardEvent` sequences to open react-select, ARIA `aria-controls`/`aria-owns` scoping to read portal-mounted option menus, `MutationObserver` SPA-navigation and Workday stage polling, `DataTransfer` file injection for resume upload |
| **Answer resolution** | A pure, DOM-free engine in `src/lib/adapters/generic.ts` (`desiredAnswer`, `matchOption`, `workAuthWantYes`, `eeoAnswer`) reused verbatim by every ATS adapter |
| **Extension APIs** | `chrome.runtime` messaging, `chrome.storage.local` + `chrome.storage.session`, `chrome.scripting.executeScript` (on-demand injection), `chrome.action` badge, `chrome.tabs` |
| **Backend client** | `fetch` with `AbortSignal.timeout` budgets, Bearer-JWT `Authorization`, typed request/response layer in `src/lib/api.ts`, base URL from `VITE_API_BASE` |
| **Testing** | Vitest 4.1.10 for unit and integration coverage, plus Testing Library, user-event, and jsdom for popup workflow behavior |
| **Dev tooling** | `tsc --noEmit` type-check, a standalone Vite preview harness (`preview.tsx` + `preview/mock-server.mjs`) that renders every popup screen with mock data |

---

## The popup: onboarding, setup, outreach (`src/entrypoints/popup`, `src/components`)

The popup is a small React app (`App.tsx`) that routes between six screens with local state. It reads auth from `chrome.storage.local` on open and drops the student into onboarding if there is no token and profile.

- **Onboarding** (`OnboardingScreen.tsx`): email plus a resume PDF. The backend emails a six-digit code (`/auth/request-code` then `/auth/verify-code`); if the backend has no email provider configured it returns a 503 and the screen falls back to a legacy passwordless session (`/auth/session`). The uploaded PDF is posted to `/profile`, parsed server-side, and stored.
- **Autofill setup** (`AutofillSetupScreen.tsx`): a four-step wizard reached automatically right after signup so nothing is ever asked mid-application. It seeds an "experience bank" from the parsed resume, collects the application profile (city, citizenship, work authorization, sponsorship, availability, salary, DOB, links), lets the student optionally fill EEO answers (blank means "decline to self-identify" on every form), and exposes the **auto-submit toggle** (off by default). Sensitive-last ordering is deliberate.
- **Main** (`MainScreen.tsx`): shows the job spotted on the current page, a "Find my people" form that calls `/resolve`, and a "Fill the form on this page" button that injects the content script on demand via `chrome.scripting.executeScript` for company career sites the manifest cannot match.
- **Contacts / Draft / Tracking** (`ContactList.tsx`, `DraftEditor.tsx`, `TrackingDashboard.tsx`): review resolved contacts, edit a generated outreach email, open it prefilled in Gmail (`buildGmailComposeLink` in `src/lib/gmail.ts` builds a `mail.google.com` compose URL), and log sends to `/track/event`.

The visual system lives in `tailwind.config.ts` and `src/components/ui.tsx`: a restrained blue accent, warm neutrals, shared form and button primitives, and short functional transitions. [DESIGN.md](DESIGN.md) records the interface rules, and [CHANGELOG.md](CHANGELOG.md) tracks each release.

## The content script and card system (`src/entrypoints/content.ts`)

`content.ts` (just over 1,000 lines) is the on-page brain. It is injected on a fixed allowlist of ATS hosts and, on demand, into any company page the student explicitly asks to fill.

- **Matches** (`content.ts`, `persistent-badge.ts`): `linkedin.com`, `*.greenhouse.io`, `*.lever.co`, `*.myworkdayjobs.com`, `*.workday.com`, `*.ashbyhq.com`, `www.indeed.com`, and Handshake. `all_frames: true` lets the script inject directly into a cross-origin Greenhouse board embedded in an iframe on a company's own domain (matches are evaluated per-frame, so the iframe instance runs with the greenhouse.io origin and reaches the real form DOM with no cross-frame messaging).
- **Job detection** (`getJobDetails`): per-host title/company extraction (LinkedIn `document.title` split, Greenhouse `app-title` with a `document.title` fallback for the `/embed/job_app` template that renders no `h1`, Lever posting headline, Workday `jobPostingHeader`, Ashby, Indeed, Handshake).
- **The card stack** (`getCardStack`): every prompt renders into one fixed bottom-right stack. There is an outreach card ("Draft recruiter emails?"), a submit-time card, a resume-fill card, and Workday-specific account-creation and start-screen cards.
- **Pre-warm on hover, not render** (`injectResumeFillCard`): resume generation is the slowest step (a real LLM round trip on the backend) and it costs a monthly credit, so it starts on the first `mouseenter` of the card, hiding most of the latency behind the user's intent without charging a generation for a card the student dismisses.
- **SPA and Workday handling**: a `MutationObserver` watches `location.href` for single-page navigations and re-runs detection; Workday additionally gets a bounded 1.5s poll because some tenants swap stages (start screen to account creation to real form) with no URL change.

## Fill-and-stop and the auto-submit countdown

The single most important behavior is the safety model. After an adapter fills a form, the content script resolves the page's real Submit button and, by default, only outlines it in indigo and tells the student to review and submit themselves. It never clicks it.

If (and only if) the student turned on auto-submit in setup, `runAutoSubmitCountdown` anchors a live 15-second countdown ring directly over that exact button: a depleting SVG ring, the seconds remaining, and a large Cancel control, repositioned on scroll and resize so it tracks the real button. Escape cancels, Cancel cancels, closing the card cancels, and an SPA navigation cancels (a stale countdown must never submit a newly navigated form). When it fires, it clicks only the specific button it anchored - never a re-resolved one - and hands back if that button has since detached. Every fill reports an anonymized `AUTOFILL_EVENT` (ATS name, fields filled/skipped, whether it auto-submitted) to `/autofill/event`.

## The autofill adapter layer (`src/lib/adapters`)

Each ATS renders the same question differently, so each gets its own adapter, but they all share one answer engine and one set of DOM primitives. Every adapter returns an `AutofillResult` (`ats_name`, `fields_filled`, `fields_skipped`, `skipped_reasons`) so the UI can report exactly what was and was not touched.

- **`generic.ts`**: the adapter for company-hosted forms that build their own UI against an ATS API, and the home of the shared pure answer engine. It matches every field by the text a human reads (label, aria-label, placeholder, name, id, in that order of trust), groups radios and checkboxes by shared `name`, derives a radio group's question stem by climbing to the ancestor that contains exactly the group's options and subtracting each option's label, drives comboboxes, AI-drafts open-ended textareas through a bounded three-worker queue and flags each with an amber "review before submitting" badge, and injects the generated resume through a `DataTransfer`. It only ever runs when the student explicitly clicked "Fill the form on this page," so running is itself proof of an intentional request.
- **`greenhouse.ts`** (401 lines): handles both the current id-based template (`#first_name`, `#candidate-location`, `#resume`, empty `name` attributes) and legacy `job_application[...]` name-based boards, drives the react-select yes/no, EEO, and location comboboxes verified live against a real posting, and works inside the cross-origin iframe embed.
- **`lever.ts`** (318 lines): the recommended first-ship ATS (simple same-page static form), label-matched custom questions.
- **`ashby.ts`** (482 lines): stable `_systemfield_*` identity fields, with the live-tested fix for Ashby's two file inputs (its own resume-parser widget comes first in DOM order; the real application field is `#_systemfield_resume`).
- **`workday.ts`** (485 lines): built against Workday's documented `data-automation-id` conventions across tenants, with account-creation vs real-form detection, an email-only account-creation fill (password is never touched, by explicit product decision), and start-screen guidance that points the student at "Apply Manually."
- **`linkedin.ts`** (401 lines): Easy Apply modal fill, label-matched because LinkedIn assigns per-posting field ids; fills the currently visible step only and never advances or submits.

### The shared answer engine and DOM primitives

Two files keep every adapter honest:

- **`generic.ts` pure exports** (`desiredAnswer`, `matchOption`, `workAuthWantYes`, `eeoAnswer`, `Desired`): DOM-free logic that maps a question label to a desired answer and picks the best option. This is where the visa-inversion, EEO-decline-by-default, word-boundary matching (so "Asian" does not match "Caucasian"), and "leave ambiguous questions blank" rules live. The ATS adapters import these directly so a Greenhouse question and a generic question resolve identically.
- **`shared/dom.ts`**: `commitChoice` (click-first radio/checkbox commit that survives controlled-component re-render, born from a real bug where poked radios reverted on submit), `setNativeValue` / `fillField` (native-setter writes plus `input`+`change` so React sees a real edit), `randomDelay` (human-like pacing between writes), and the combobox suite (`openCombobox`, `pickComboOption`, `closeOpenCombobox`) that opens react-select through focus + pointer + keyboard fallbacks and reads its portal-mounted options scoped by ARIA ownership. A shared `NEVER_FILL_LABEL_PATTERNS` list (SSN, driver's license, background-check consent) is enforced by every adapter.

## The background service worker and backend client (`src/entrypoints/background.ts`, `src/lib/api.ts`)

The background worker is the only component that holds the auth token, so it owns every authenticated backend call. It routes `chrome.runtime` messages: `JOB_DETECTED` / `GET_LAST_JOB` (badge + session cache), `JOB_APPROVED` (resolve contacts and draft the best two, ranked by reply likelihood so an alumni or near-peer outranks a busy exec), `GENERATE_RESUME_AND_FILL_DATA` (fetch the resume profile and the more-sensitive application profile in parallel, then generate a JD-tailored resume), `ANSWER_QUESTION` (draft one open-ended application answer), `GET_ACCOUNT_CREATION_DATA` (email only, for Workday signup), and `AUTOFILL_EVENT` (telemetry). It is careful about Manifest V3 service-worker teardown, only keeping the message channel open when a response is genuinely coming.

`src/lib/api.ts` is the typed client for the Litos backend. Development defaults to `http://localhost:3001`, production defaults to `https://student-outreach-backend.vercel.app`, and `VITE_API_BASE` overrides either mode. Endpoints the extension calls:

| Purpose | Endpoint | What the backend does |
|---------|----------|-----------------------|
| Verified signup | `POST /auth/request-code`, `/auth/verify-code`, `/auth/session` | Email a code, mint a JWT |
| Resume profile | `POST /profile` (multipart), `GET /profile` | Parse the uploaded resume PDF into structured JSON |
| Experience bank | `GET`/`PUT /profile/experience-bank` | Store editable experience entries |
| Application profile | `GET`/`PUT /profile/application` | Store the non-resume facts (phone, work-auth, EEO, links) |
| Contact resolution | `POST /resolve` | Find and email-verify contacts at the company |
| Outreach draft | `POST /draft` | Write a personalized outreach email |
| Tailored resume | `POST /resume/generate` | Generate a JD-tailored resume, return a file URL |
| Essay answer | `POST /application/answer` | Draft one open-ended application answer |
| Tracking + telemetry | `POST /track/event`, `GET /track/events`, `POST /autofill/event` | Log outreach and fill events |

The division of labor is strict: **the extension does detection, orchestration, DOM filling, and the safety UI; the backend does every piece of language generation and contact resolution.** No LLM call is made from the extension itself.

---

## Installing and running it

The published extension is on the Chrome Web Store (link at the top). To build and load it from source:

```bash
npm install                 # runs `wxt prepare` on postinstall

# Point development or QA builds at a different backend when needed.
# Copy .env.example to .env and set:
#   VITE_API_BASE=https://your-backend.example.com

npm run dev                 # WXT dev server + hot-reloaded extension (Chrome)
npm run build               # production build into .output/chrome-mv3
npm run build:firefox       # Firefox MV3 build
npm run zip                 # packaged .zip for the Chrome Web Store
```

Then load the unpacked build: open `chrome://extensions`, enable Developer mode, choose "Load unpacked," and point it at `.output/chrome-mv3` (the directory WXT writes). Sign in through the popup, complete autofill setup, and open a real posting on any supported ATS.

**Visual preview without Chrome or a backend:**

```bash
npm run preview             # mock API on :3001 + Vite on :4700
# open http://localhost:4700/preview.html
```

`preview.tsx` renders seven popup states side by side with canned data from `preview/mock-server.mjs`, including both loaded and loading contact states, so the UI can be eyeballed without loading the extension. It is dev-only; WXT bundles `src/` for production. See [preview/README.md](preview/README.md) for the harness layout and extension points.

## Testing

```bash
npm run compile             # tsc --noEmit type-check
npm test                    # vitest run
npm run test:watch          # vitest watch
```

The suite covers the fill decisions most likely to cause real-world harm and the popup workflows users rely on. `generic.answers.test.ts` and `ats-answer.test.ts` lock in visa-phrasing inversion, EEO decline-by-default, exact option matching, and the "leave ambiguous groups blank" rule across every ATS adapter. `redesign.behavior.test.tsx` covers signup validation, asynchronous job detection, contact resolution, Gmail handoff, outreach tracking, and recoverable error states. Production configuration tests also verify the release version and backend defaults.

## Permissions (`wxt.config.ts`)

The manifest requests only `activeTab`, `scripting`, `storage`, and `clipboardWrite`, and declares no production `host_permissions` (localhost only during `wxt serve`). The content-script `matches` list is the specific ATS allowlist rather than `<all_urls>`, and on-demand injection into company career sites goes through `activeTab` + `chrome.scripting` on the tab the student invoked. This is a conscious choice: every extra permission widens the install warning and slows Chrome Web Store review, and the whole product only needs to touch the tab the user is actively applying on.

## Naming and storage compatibility

The product is Litos. It previously shipped as RoleQuick and, before that, Volley. Persisted `chrome.storage.local` values now use `litos_*` keys with backward-compatible reads from both earlier key families (see `src/lib/storage.ts` and `migrateLegacyStorage`), so existing users keep their saved token, profile, and settings through the update. The package name, injected DOM ids, window globals, and all new identifiers use the `litos` name.

## Scope

**In:** Lever, Greenhouse, Ashby, Workday, and LinkedIn Easy Apply, plus a generic label-driven adapter for company-hosted forms; JD-tailored resume generation, application autofill, and outreach drafting; fill-and-stop by default with an opt-in, cancelable auto-submit countdown.

**Out (deliberately):** the extension never creates third-party accounts, never touches password fields, never fills SSN / driver's license / background-check consent, never checks a legal-agreement or accuracy-certification box, and never clicks Submit unless the student explicitly opted in per session and let the on-button countdown run. All AI generation stays on the backend; the extension is a client.
