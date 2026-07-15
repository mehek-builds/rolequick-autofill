import { isLeverApplicationPage, extractLeverJdText, fillLeverApplication } from '../lib/adapters/lever';
import { isGreenhouseApplicationPage, extractGreenhouseJdText, fillGreenhouseApplication } from '../lib/adapters/greenhouse';
import { isAshbyApplicationPage, extractAshbyJdText, fillAshbyApplication } from '../lib/adapters/ashby';
import {
  isWorkdayApplicationPage, extractWorkdayJdText, fillWorkdayApplication,
  isWorkdayAccountCreationPage, fillWorkdayAccountCreation,
  isWorkdayStartScreen, findApplyManuallyButton,
} from '../lib/adapters/workday';
import { isLinkedInApplicationPage, extractLinkedInJdText, fillLinkedInApplication } from '../lib/adapters/linkedin';
import { isLikelyApplicationForm, extractGenericJdText, getGenericJobDetails, fillGenericApplication } from '../lib/adapters/generic';
import { getAutoSubmitEnabled } from '../lib/storage';
import type { Profile, ApplicationProfile, AutofillResult } from '../lib/types';

export default defineContentScript({
  matches: [
    'https://www.linkedin.com/*',
    'https://linkedin.com/*',
    'https://*.greenhouse.io/*',
    'https://*.lever.co/*',
    'https://*.myworkdayjobs.com/*',
    'https://*.workday.com/*',
    'https://*.ashbyhq.com/*',
    'https://www.indeed.com/*',
    'https://app.joinhandshake.com/*',
    'https://joinhandshake.com/*',
  ],
  // Some companies embed their Greenhouse board in an iframe hosted on greenhouse.io while the
  // parent page is on the company's own domain (Section 9/12.3 of PRD-v2). `matches` is evaluated
  // per-frame, so all_frames lets this script inject directly into that iframe - it runs with the
  // iframe's own greenhouse.io origin, not the parent page's, so no cross-frame messaging is needed.
  allFrames: true,
  runAt: 'document_idle',
  main() {
    // No top-frame gating: for a cross-origin Greenhouse iframe embed, this script's instance
    // running INSIDE that iframe is the only one that ever matches `*.greenhouse.io/*` at all
    // (the parent page is on the company's own domain, which isn't in `matches`). That iframe
    // instance is also the only one with access to the actual form DOM, so its card must render
    // in its own document - a `position: fixed` card inside an iframe is scoped to that iframe's
    // own viewport, which is correct here since Greenhouse embeds are typically full-size.

    // Besides the manifest matches, this same file is injected ON DEMAND (popup's "Fill the
    // form on this page" button -> activeTab + chrome.scripting) into company career sites
    // that host their own application form. A second click re-executes the whole bundle in
    // the same isolated world, so guard against double-running: the repeat call just re-shows
    // the generic card instead of standing up a second set of observers.
    const w = window as unknown as { __volleyLoaded?: boolean; __volleyGenericInit?: () => void };
    if (w.__volleyLoaded) {
      w.__volleyGenericInit?.();
      return;
    }
    w.__volleyLoaded = true;

    let cardInjected = false;
    let approved = false; // true once user taps "Yes" on either card

    // ─── Job title/company extraction ───────────────────────────────────────

    function getJobDetails(): { title: string; company: string } | null {
      const h = window.location.hostname;
      const path = window.location.pathname;

      if (h.includes('linkedin.com')) {
        const parts = document.title.split(' | ');
        if (parts.length >= 2 && parts[parts.length - 1].trim() === 'LinkedIn') {
          const title = parts[0].trim();
          const company = parts[1].trim();
          if (title && company && title !== 'Jobs') return { title, company };
        }
      }

      if (h.includes('greenhouse.io')) {
        const docTitle = document.title;
        const atIdx = docTitle.lastIndexOf(' at ');
        const company = atIdx !== -1
          ? docTitle.slice(atIdx + 4).replace(/\s*\|.*$/, '').trim()
          : document.querySelector<HTMLElement>('.company-name')?.textContent?.trim() ?? h.split('.')[0];
        // The /embed/job_app template (companies embedding their board in an iframe on their
        // own careers site, e.g. databricks.com - live-tested 2026-07-04) renders NO h1 at
        // all, so without the document.title fallback getJobDetails() returned null there and
        // no card ever fired on any embedded Greenhouse application.
        const titleFromDocTitle =
          atIdx !== -1 ? docTitle.slice(0, atIdx).replace(/^job application for\s*/i, '').trim() : undefined;
        const title =
          document.querySelector<HTMLElement>('h1.app-title')?.textContent?.trim() ??
          document.querySelector<HTMLElement>('h1')?.textContent?.trim() ??
          titleFromDocTitle;
        if (title && company) return { title, company };
      }

      if (h.includes('lever.co')) {
        const title =
          document.querySelector<HTMLElement>('.posting-headline h2')?.textContent?.trim() ??
          document.querySelector<HTMLElement>('h2')?.textContent?.trim();
        const company =
          document.querySelector<HTMLElement>('.main-header-logo img')?.getAttribute('alt')?.trim().replace(/\s+logo$/i, '') ??
          path.split('/')[1];
        if (title && company) return { title, company };
      }

      if (h.includes('myworkdayjobs.com') || h.includes('workday.com')) {
        const title =
          document.querySelector<HTMLElement>('[data-automation-id="jobPostingHeader"]')?.textContent?.trim() ??
          document.querySelector<HTMLElement>('h1')?.textContent?.trim();
        const company = h.split('.')[0].replace('www', '') || document.title.split('-')[1]?.trim();
        if (title && company) return { title, company };
      }

      if (h.includes('ashbyhq.com')) {
        const title = document.querySelector<HTMLElement>('h1')?.textContent?.trim();
        const company = path.split('/')[1];
        if (title && company) return { title, company };
      }

      if (h.includes('indeed.com')) {
        const title =
          document.querySelector<HTMLElement>('[data-testid="jobsearch-JobInfoHeader-title"]')?.textContent?.trim() ??
          document.querySelector<HTMLElement>('.jobsearch-JobInfoHeader-title')?.textContent?.trim();
        const company =
          document.querySelector<HTMLElement>('[data-testid="inlineHeader-companyName"]')?.textContent?.trim() ??
          document.querySelector<HTMLElement>('.jobsearch-InlineCompanyRating-companyHeader')?.textContent?.trim();
        if (title && company) return { title, company };
      }

      if (h.includes('joinhandshake.com')) {
        const title = document.querySelector<HTMLElement>('h1')?.textContent?.trim();
        const company = document.querySelector<HTMLElement>('.company-name, [class*="employer-name"]')?.textContent?.trim();
        if (title && company) return { title, company };
      }

      return null;
    }

    // ─── Application page detection ─────────────────────────────────────────

    function isApplicationPage(): boolean {
      const h = window.location.hostname;
      const path = window.location.pathname.toLowerCase();

      if (h.includes('myworkdayjobs.com') || h.includes('workday.com')) {
        return path.includes('/apply') || (path.includes('/job/') && path.endsWith('/apply'));
      }

      if (h.includes('greenhouse.io')) {
        if (path.includes('/application') || path.includes('/apply')) return true;
        const hasResumeUpload = !!document.querySelector('input[type="file"], [data-source="resume"]');
        const hasNameField = !!document.querySelector('input[name="job_application[first_name]"], input[id*="first_name"]');
        const hasPrivacyNotice = !!document.querySelector('.gdpr-consent, [class*="privacy"], [id*="privacy"]');
        return hasResumeUpload || hasNameField || hasPrivacyNotice;
      }

      if (h.includes('lever.co')) return path.includes('/apply');
      // Live-tested 2026-07-02 (jobs.ashbyhq.com/notion): the real apply-flow path is
      // "/application", not "/apply" - see isAshbyApplicationPage()'s matching comment.
      if (h.includes('ashbyhq.com')) return path.includes('/apply') || path.includes('/application');
      if (h.includes('joinhandshake.com')) return path.includes('/apply') || path.includes('/application');
      if (h.includes('indeed.com')) {
        return path.includes('/apply') || !!document.querySelector('[id*="apply"], [class*="apply-form"]');
      }

      return false;
    }

    // ─── Submit button detection ─────────────────────────────────────────────

    function findSubmitButton(): Element | null {
      // Try specific ATS selectors first, then fall back to generic
      const selectors = [
        '[data-automation-id="bottom-navigation-next-button"]', // Workday final step
        'input[type="submit"]',
        'button[type="submit"]',
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) return el;
      }

      // Generic: find a button whose text contains "Submit"
      const allButtons = document.querySelectorAll('button, input[type="button"]');
      for (const btn of allButtons) {
        const text = (btn.textContent ?? (btn as HTMLInputElement).value ?? '').toLowerCase();
        if (text.includes('submit') && !text.includes('resume')) return btn;
      }

      return null;
    }

    function watchSubmitButton(title: string, company: string, url: string) {
      let watched = false;
      let observer: MutationObserver | null = null;

      function attachListener() {
        if (watched) return;
        const btn = findSubmitButton();
        if (!btn) return;
        watched = true;
        // The button exists; stop re-scanning the whole body subtree on every mutation.
        // Without this the observer runs findSubmitButton() (several querySelectorAll + a text
        // scan of every button) on each DOM change for the life of the tab.
        observer?.disconnect();

        btn.addEventListener('click', () => {
          if (approved) return; // Already drafting from card 1
          // Remove card 1 if still showing
          document.getElementById('volley-action-card')?.remove();
          cardInjected = false;
          injectSubmitCard(title, company, url);
        });
      }

      // Try immediately; only fall back to watching for the button (multi-step forms) if it
      // isn't there yet, and disconnect as soon as it is (in attachListener).
      attachListener();
      if (!watched) {
        observer = new MutationObserver(() => attachListener());
        observer.observe(document.body, { childList: true, subtree: true });
      }
    }

    // ─── LinkedIn Easy Apply modal detection ────────────────────────────────

    function watchLinkedInEasyApply(title: string, company: string) {
      const modalSelectors = [
        '[data-test-modal-id="easy-apply-modal"]',
        '[aria-label="Easy Apply"]',
        '.jobs-easy-apply-modal',
        '[class*="easy-apply-modal"]',
      ];

      function checkForModal() {
        const modal = modalSelectors.reduce<Element | null>(
          (found, sel) => found ?? document.querySelector(sel),
          null
        );
        if (modal && !cardInjected) {
          injectActionCard(title, company, window.location.href);
          // Also watch for the submit button inside the modal
          watchSubmitButton(title, company, window.location.href);
        }
        // Fill-and-stop, same as Lever/Greenhouse/Ashby (2026-07-02: form-fill now runs
        // on LinkedIn too, not just resume-gen). Easy Apply already implies a real
        // LinkedIn account exists (there's no separate account-creation step inside it).
        if (isLinkedInApplicationPage()) {
          injectResumeFillCard(title, company, extractLinkedInJdText, fillLinkedInApplication);
        }
      }

      const easyApplyBtns = document.querySelectorAll(
        '[data-control-name="jobs_apply_button"], [aria-label*="Easy Apply"], button[class*="easy-apply"]'
      );

      easyApplyBtns.forEach((btn) => {
        btn.addEventListener('click', () => {
          let attempts = 0;
          const poll = setInterval(() => {
            checkForModal();
            if (++attempts >= 10 || cardInjected) clearInterval(poll);
          }, 300);
        });
      });

      const modalObserver = new MutationObserver(() => {
        if (!cardInjected) checkForModal();
      });
      modalObserver.observe(document.body, { childList: true, subtree: true });
    }

    // ─── Card helpers ────────────────────────────────────────────────────────

    // Every card goes into one fixed bottom-right stack and flows vertically (2026-07-04,
    // Mehek's direction) - previously each card type carried its own hardcoded `right` offset
    // (20px / 306px), which put two simultaneous cards side by side and would overlap them
    // outright if a third ever fired. Cards keep their own ids; removing one collapses the
    // stack naturally, and an empty container is invisible.
    function getCardStack(): HTMLElement {
      let stack = document.getElementById('volley-card-stack');
      if (!stack) {
        stack = document.createElement('div');
        stack.id = 'volley-card-stack';
        stack.style.cssText =
          'position:fixed;bottom:72px;right:20px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:12px;';
        document.body.appendChild(stack);
      }
      return stack;
    }

    function cardShell(headline: string, subline: string): string {
      return `
        <div style="
          position: relative;
          background: white;
          border: 1.5px solid #e0e7ff;
          border-radius: 14px;
          padding: 16px 16px 14px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 13px;
          line-height: 1.4;
          box-shadow: 0 8px 32px rgba(79,70,229,0.18);
          width: 272px;
          box-sizing: border-box;
          animation: wp-slide-in 0.25s ease-out;
        ">
          <button id="wp-close" style="position:absolute;top:10px;right:12px;background:none;border:none;cursor:pointer;font-size:17px;opacity:0.4;color:#333;padding:0;line-height:1;">×</button>
          <div style="display:flex;align-items:flex-start;gap:9px;margin-bottom:12px;line-height:1.4;">
            <span style="font-size:20px;flex-shrink:0;margin-top:1px;line-height:1;">🔥</span>
            <div>
              <div style="font-weight:700;font-size:13px;color:#1e1b4b;line-height:1.4;">${headline}</div>
              <div style="font-size:12px;color:#6366f1;margin-top:2px;word-break:break-word;line-height:1.4;">${subline}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;">
            <button id="wp-yes" style="
              flex:1;background:#4f46e5;color:white;border:none;border-radius:8px;
              padding:9px 0;font-size:12px;font-weight:600;cursor:pointer;
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            ">Yes, draft emails</button>
            <button id="wp-no" style="
              flex:1;background:#f3f4f6;color:#374151;border:none;border-radius:8px;
              padding:9px 0;font-size:12px;font-weight:600;cursor:pointer;
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            ">Not this one</button>
          </div>
        </div>
        <style>
          @keyframes wp-slide-in {
            from { transform: translateY(16px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
        </style>
      `;
    }

    function attachCardHandlers(card: HTMLElement, title: string, company: string, url: string) {
      const dismiss = () => { card.remove(); cardInjected = false; };
      card.querySelector('#wp-close')?.addEventListener('click', dismiss);
      card.querySelector('#wp-no')?.addEventListener('click', dismiss);
      card.querySelector('#wp-yes')?.addEventListener('click', () => {
        approved = true;
        const inner = card.querySelector('div') as HTMLElement;
        inner.innerHTML = `
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-size:20px;">⏳</span>
            <div>
              <div style="font-weight:700;font-size:13px;color:#1e1b4b;">Finding contacts &amp; drafting...</div>
              <div style="font-size:12px;color:#6366f1;margin-top:2px;">Open RoleQuick when ready</div>
            </div>
          </div>
        `;
        chrome.runtime.sendMessage({ type: 'JOB_APPROVED', payload: { title, company, url } });
        setTimeout(dismiss, 3500);
      });
    }

    // Card 1: fires when application form loads
    function injectActionCard(title: string, company: string, url: string) {
      if (cardInjected || document.getElementById('volley-action-card')) return;
      cardInjected = true;

      chrome.runtime.sendMessage({ type: 'JOB_DETECTED', payload: { title, company, url } });

      const card = document.createElement('div');
      card.id = 'volley-action-card';
      card.innerHTML = cardShell(
        'Draft recruiter emails?',
        `${title} at ${company}`
      );
      getCardStack().appendChild(card);
      attachCardHandlers(card, title, company, url);
    }

    // Card 2: fires when Submit button is clicked (only if not already approved)
    function injectSubmitCard(title: string, company: string, url: string) {
      if (approved || document.getElementById('volley-submit-card')) return;
      cardInjected = true;

      const card = document.createElement('div');
      card.id = 'volley-submit-card';
      card.innerHTML = cardShell(
        "You're applying - draft outreach emails while you wait?",
        `${title} at ${company}`
      );
      getCardStack().appendChild(card);
      attachCardHandlers(card, title, company, url);
    }

    // ─── v2: resume-gen + Lever autofill (fill-and-stop, never clicks Submit) ──────────

    function resumeFillCardShell(title: string, company: string): string {
      return `
        <div style="
          position: relative;
          background: white; border: 1.5px solid #e0e7ff; border-radius: 14px;
          padding: 16px 16px 14px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 13px; line-height: 1.4; box-shadow: 0 8px 32px rgba(79,70,229,0.18);
          width: 272px; box-sizing: border-box; animation: wp-slide-in 0.25s ease-out;
        ">
          <button id="wp-resume-close" style="position:absolute;top:10px;right:12px;background:none;border:none;cursor:pointer;font-size:17px;opacity:0.4;color:#333;padding:0;line-height:1;">×</button>
          <div style="display:flex;align-items:flex-start;gap:9px;margin-bottom:12px;line-height:1.4;">
            <span style="font-size:20px;flex-shrink:0;margin-top:1px;line-height:1;">📄</span>
            <div>
              <div style="font-weight:700;font-size:13px;color:#1e1b4b;line-height:1.4;">Generate tailored resume + fill this application?</div>
              <div style="font-size:12px;color:#6366f1;margin-top:2px;word-break:break-word;line-height:1.4;">${title} at ${company}</div>
            </div>
          </div>
          <div id="wp-resume-status" style="font-size:11px;color:#6b7280;margin-bottom:8px;display:none;line-height:1.4;"></div>
          <div style="display:flex;gap:8px;">
            <button id="wp-resume-yes" style="
              flex:1;background:#4f46e5;color:white;border:none;border-radius:8px;
              padding:9px 0;font-size:12px;font-weight:600;cursor:pointer;
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            ">Yes, fill it</button>
            <button id="wp-resume-no" style="
              flex:1;background:#f3f4f6;color:#374151;border:none;border-radius:8px;
              padding:9px 0;font-size:12px;font-weight:600;cursor:pointer;
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            ">No thanks</button>
          </div>
        </div>
      `;
    }

    type FillFn = (params: {
      fullName: string;
      email?: string;
      profile: Profile;
      applicationProfile: ApplicationProfile;
      resumeBlob?: Blob;
      resumeFileName?: string;
      // Generic-adapter-only extras (ATS adapters ignore them). eeo carries the student's
      // demographic prefs for EEO questions; draftAnswer AI-drafts an open-ended textarea.
      eeo?: Record<string, string>;
      draftAnswer?: (question: string) => Promise<string | null>;
      onProgress?: (partial: { fields_filled: number; fields_skipped: number; ai_drafted: number; pendingEssays: number }) => void;
    }) => Promise<AutofillResult>;

    // Shared by every ATS adapter: generate the JD-tailored resume, then run that adapter's
    // client-side fill-and-stop. Only the JD-extraction and fill functions differ per ATS.
    function injectResumeFillCard(title: string, company: string, extractJdText: () => string, fill: FillFn) {
      if (document.getElementById('volley-resume-card')) return;
      const card = document.createElement('div');
      card.id = 'volley-resume-card';
      card.innerHTML = resumeFillCardShell(title, company);
      getCardStack().appendChild(card);

      // Pre-warm on first HOVER of the card, not on render. Resume generation is the slowest
      // step (an LLM round trip), so starting it before "Yes" hides most of the wait - but a
      // render-time pre-warm charged one backend generation (real Anthropic spend AND one of
      // the monthly resume credits, plus an hourly rate-limit slot) for every card the student
      // dismissed. Hover is the earliest reliable signal of intent: it still fires seconds
      // before a click, keeping nearly all of the head start at none of the dismissal cost.
      const jdText = extractJdText();
      type ResumeGenResult = {
        error?: string;
        profile?: Profile;
        applicationProfile?: ApplicationProfile;
        resume?: { resume_url: string; file_name: string };
      };
      // Slightly longer than the background's own resume-fetch budget (60s) so its descriptive
      // error surfaces first; this is the backstop for the worse case where the service worker
      // is torn down and the callback never fires at all.
      const RESUME_GEN_TIMEOUT_MS = 65000;
      let resumeGenPromise: Promise<ResumeGenResult> | null = null;
      const startResumeGen = (): Promise<ResumeGenResult> => {
        resumeGenPromise ??= new Promise<ResumeGenResult>((resolve) => {
          let settled = false;
          const done = (r: ResumeGenResult) => { if (!settled) { settled = true; resolve(r); } };
          const timer = setTimeout(
            () => done({ error: 'Resume generation timed out - fill this form manually.' }),
            RESUME_GEN_TIMEOUT_MS,
          );
          chrome.runtime.sendMessage(
            { type: 'GENERATE_RESUME_AND_FILL_DATA', payload: { company, role: title, jd_text: jdText } },
            (result: ResumeGenResult | undefined) => {
              clearTimeout(timer);
              // A dead service worker resolves the callback with lastError set (or with no
              // result), rather than the response object - treat both as a recoverable error
              // instead of letting `undefined` fall through as a fake success.
              if (chrome.runtime.lastError || !result) {
                done({ error: chrome.runtime.lastError?.message || 'Could not reach the extension - fill this form manually.' });
              } else {
                done(result);
              }
            },
          );
        });
        return resumeGenPromise;
      };
      card.addEventListener('mouseenter', () => void startResumeGen(), { once: true });

      const dismiss = () => card.remove();
      card.querySelector('#wp-resume-close')?.addEventListener('click', dismiss);
      card.querySelector('#wp-resume-no')?.addEventListener('click', dismiss);
      card.querySelector('#wp-resume-yes')?.addEventListener('click', async () => {
        const statusEl = card.querySelector<HTMLElement>('#wp-resume-status');
        const yesBtn = card.querySelector<HTMLButtonElement>('#wp-resume-yes');
        if (yesBtn) yesBtn.disabled = true;
        if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Tailoring your resume...'; }

        const result = await startResumeGen();
        if (!result || result.error || !result.profile || !result.applicationProfile || !result.resume) {
          if (statusEl) statusEl.textContent = result?.error || 'Could not generate a resume - fill this one manually.';
          return;
        }

        if (statusEl) statusEl.textContent = 'Filling the application...';

        let resumeBlob: Blob | undefined;
        try {
          const blobRes = await fetch(result.resume.resume_url);
          // Without the ok check, a 403/404 error page would be handed to the file input as if
          // it were the PDF; better to skip the file (the adapter flags it) than upload garbage.
          if (!blobRes.ok) throw new Error(`resume fetch ${blobRes.status}`);
          resumeBlob = await blobRes.blob();
        } catch {
          // No resume file available client-side; the adapter will skip the file input
          // and flag it rather than fail the whole fill.
        }

        // Safety net: a stuck field (an unexpected widget, a listener that never fires) must
        // never leave the student staring at "Filling the application..." forever with no way
        // to know what happened. This is a true-hang backstop, NOT a routine budget: every
        // adapter now AI-drafts open-ended essays inside fill() (parallel LLM round trips, each
        // able to fire a grounding-retry), so a form with a few essays can legitimately run well
        // past 20s. At the old 20s this race routinely tripped on essay-heavy forms, dismissed
        // the card, and let the essays fill in AFTER the student was told to finish manually.
        // 90s only fires on a genuine hang; onProgress streams field counts meanwhile so the
        // student is never staring at a frozen status.
        const FILL_TIMEOUT_MS = 90000;
        let fillResult: AutofillResult;
        try {
          fillResult = await Promise.race([
            fill({
              fullName: result.profile.full_name ?? '',
              email: result.profile.email,
              profile: result.profile,
              applicationProfile: result.applicationProfile,
              resumeBlob,
              resumeFileName: result.resume.file_name,
              // Generic-adapter extras (ATS adapters ignore them): EEO prefs for demographic
              // questions, and an AI-draft hook for open-ended textareas routed through the
              // background to the backend. jdText/company/title are already in scope here.
              eeo: (result.applicationProfile?.eeo_prefs as Record<string, string> | undefined) ?? {},
              draftAnswer: (question: string) =>
                new Promise<string | null>((resolve) => {
                  chrome.runtime.sendMessage(
                    { type: 'ANSWER_QUESTION', payload: { company, role: title, jd_text: jdText, question } },
                    (r: { answer?: string | null } | undefined) => resolve(r?.answer ?? null),
                  );
                }),
              // Streamed progress: instant fields report immediately, then each essay updates
              // the count as its own draft call resolves, instead of the status text sitting on
              // "Filling the application..." until every essay in the form is done.
              onProgress: (partial) => {
                if (!statusEl) return;
                const essayNote = partial.pendingEssays > 0
                  ? ` Drafting ${partial.pendingEssays} more essay${partial.pendingEssays === 1 ? '' : 's'}...`
                  : '';
                statusEl.textContent = `Filled ${partial.fields_filled} field${partial.fields_filled === 1 ? '' : 's'}.${essayNote}`;
              },
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('timed out')), FILL_TIMEOUT_MS),
            ),
          ]);
        } catch {
          if (statusEl) statusEl.textContent = 'This form is taking too long to fill - some fields may be partially filled. Review and finish it yourself.';
          if (yesBtn) yesBtn.style.display = 'none';
          setTimeout(dismiss, 8000);
          return;
        }

        const submitBtn = findSubmitButton();
        const autoSubmitOn = await getAutoSubmitEnabled();

        const reportEvent = (autoSubmitted: boolean) => {
          chrome.runtime.sendMessage({
            type: 'AUTOFILL_EVENT',
            payload: {
              ats_name: fillResult.ats_name,
              job_context: { company, role: title },
              fields_filled: fillResult.fields_filled,
              fields_skipped: fillResult.fields_skipped,
              auto_submitted: autoSubmitted,
            },
          });
        };

        // Auto-submit is opt-in (AutofillSetupScreen toggle, off by default) and only ever
        // fires from THIS student's own extension, in their own logged-in session, on data
        // they generated and could still cancel - never something Volley decides on its own.
        if (autoSubmitOn && submitBtn instanceof HTMLElement) {
          runAutoSubmitCountdown(
            card, statusEl,
            card.querySelector<HTMLButtonElement>('#wp-resume-yes'),
            card.querySelector<HTMLButtonElement>('#wp-resume-no'),
            submitBtn, fillResult, reportEvent, 'Submitting',
          );
          return;
        }

        reportEvent(false);

        if (statusEl) {
          statusEl.textContent = `Filled ${fillResult.fields_filled} field${fillResult.fields_filled === 1 ? '' : 's'}. Review, then submit yourself.`;
        }

        // Highlight, never click - Volley stops here (PRD-v2 Section 5 Step 4) unless the
        // student has opted in to auto-submit above.
        if (submitBtn instanceof HTMLElement) {
          submitBtn.style.outline = '3px solid #4f46e5';
          submitBtn.style.outlineOffset = '2px';
        }

        setTimeout(dismiss, 6000);
      });
    }

    const AUTO_SUBMIT_COUNTDOWN_SECONDS = 15;

    // Opt-in only (AutofillSetupScreen toggle). Instead of clicking Submit the instant the fill
    // finishes, this anchors a live countdown timer directly onto the page's own Submit button:
    // a depleting ring with the seconds remaining and a big Cancel control, pinned over the
    // button and following it on scroll/resize. The student sees exactly what is about to be
    // clicked and has a full 15s + Cancel + Escape to stop it, so nothing real goes out without a
    // clear, on-the-button window to back out.
    function runAutoSubmitCountdown(
      card: HTMLElement,
      statusEl: HTMLElement | null,
      yesBtn: HTMLButtonElement | null,
      noBtn: HTMLButtonElement | null,
      submitBtn: HTMLElement,
      fillResult: AutofillResult,
      reportEvent: (autoSubmitted: boolean) => void,
      actionLabel: string,
    ) {
      if (yesBtn) yesBtn.style.display = 'none';

      let remaining = AUTO_SUBMIT_COUNTDOWN_SECONDS;
      let cancelled = false;
      const RADIUS = 20;
      const CIRC = 2 * Math.PI * RADIUS;

      // The button itself gets a highlighted ring so it's unmistakable which control the timer
      // is counting down toward.
      submitBtn.style.outline = '3px solid #4f46e5';
      submitBtn.style.outlineOffset = '3px';
      submitBtn.style.borderRadius = getComputedStyle(submitBtn).borderRadius || '8px';

      const overlay = document.createElement('div');
      overlay.id = 'volley-autosubmit-overlay';
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;pointer-events:none;' +
        "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";
      overlay.innerHTML = `
        <div id="wp-as-panel" style="
          pointer-events:auto;position:absolute;display:flex;align-items:center;gap:12px;
          background:#1e1b4b;color:#fff;border-radius:12px;padding:10px 12px;
          box-shadow:0 10px 34px rgba(30,27,75,0.42);white-space:nowrap;
          animation:wp-slide-in 0.2s ease-out;
        ">
          <div style="position:relative;width:46px;height:46px;flex-shrink:0;">
            <svg width="46" height="46" viewBox="0 0 46 46" style="transform:rotate(-90deg);">
              <circle cx="23" cy="23" r="${RADIUS}" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="4"/>
              <circle id="wp-as-ring" cx="23" cy="23" r="${RADIUS}" fill="none" stroke="#a5b4fc"
                stroke-width="4" stroke-linecap="round" stroke-dasharray="${CIRC}"
                stroke-dashoffset="0" style="transition:stroke-dashoffset 1s linear;"/>
            </svg>
            <div id="wp-as-num" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;">${remaining}</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px;">
            <div style="font-size:12px;font-weight:700;">${actionLabel} your application</div>
            <div id="wp-as-sub" style="font-size:11px;color:#c7d2fe;">${fillResult.fields_filled} field${fillResult.fields_filled === 1 ? '' : 's'} filled. Auto-submits in ${remaining}s.</div>
          </div>
          <button id="wp-as-cancel" style="
            pointer-events:auto;background:#f43f5e;color:#fff;border:none;border-radius:8px;
            padding:9px 16px;font-size:12px;font-weight:700;cursor:pointer;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
          ">Cancel</button>
        </div>
      `;
      document.body.appendChild(overlay);

      const panel = overlay.querySelector<HTMLElement>('#wp-as-panel')!;
      const ring = overlay.querySelector<SVGCircleElement>('#wp-as-ring');
      const num = overlay.querySelector<HTMLElement>('#wp-as-num');
      const sub = overlay.querySelector<HTMLElement>('#wp-as-sub');

      // Keep the panel pinned just above the Submit button (falling back to just below it when
      // there isn't room), clamped inside the viewport, and re-anchored whenever the page scrolls
      // or resizes so it tracks the real button no matter where it sits on the form.
      const position = () => {
        const r = submitBtn.getBoundingClientRect();
        const p = panel.getBoundingClientRect();
        let top = r.top - p.height - 12;
        if (top < 8) top = Math.min(r.bottom + 12, window.innerHeight - p.height - 8);
        let left = r.left + r.width / 2 - p.width / 2;
        left = Math.max(8, Math.min(left, window.innerWidth - p.width - 8));
        panel.style.top = `${Math.max(8, top)}px`;
        panel.style.left = `${left}px`;
      };
      position();
      // Bring the button into view so the countdown is actually on screen, then re-anchor once
      // the smooth scroll settles.
      submitBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(position, 380);
      const reposition = () => position();
      window.addEventListener('scroll', reposition, true);
      window.addEventListener('resize', reposition);

      const cleanupChrome = () => {
        window.removeEventListener('scroll', reposition, true);
        window.removeEventListener('resize', reposition);
        window.removeEventListener('keydown', onKey);
        overlay.remove();
      };

      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        clearInterval(interval);
        cleanupChrome();
        submitBtn.style.outline = '3px solid #4f46e5';
        submitBtn.style.outlineOffset = '2px';
        if (statusEl) statusEl.textContent = 'Cancelled. Review, then submit yourself.';
        reportEvent(false);
        setTimeout(() => card.remove(), 4000);
      };

      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
      window.addEventListener('keydown', onKey);
      overlay.querySelector('#wp-as-cancel')?.addEventListener('click', cancel);
      if (noBtn) { noBtn.textContent = 'Cancel'; noBtn.onclick = cancel; }
      if (statusEl) {
        statusEl.textContent = `Filled ${fillResult.fields_filled} field${fillResult.fields_filled === 1 ? '' : 's'}. ${actionLabel} in ${remaining}s on the button - tap Cancel to review first.`;
      }

      const interval = setInterval(() => {
        remaining -= 1;
        if (cancelled) { clearInterval(interval); return; }
        if (remaining <= 0) {
          clearInterval(interval);
          if (num) num.textContent = '0';
          if (ring) ring.style.strokeDashoffset = String(CIRC);
          cleanupChrome();
          submitBtn.style.outline = '';
          submitBtn.style.outlineOffset = '';
          // Re-resolve the submit control at fire time: on a multi-step React form the button we
          // anchored to can be replaced during the countdown, and clicking a detached node is a
          // silent no-op that would falsely report a submit. If the live button is gone, stop and
          // hand back to the student rather than pretending we submitted.
          const target = submitBtn.isConnected ? submitBtn : findSubmitButton();
          if (target instanceof HTMLElement && target.isConnected) {
            if (statusEl) statusEl.textContent = `${actionLabel}...`;
            target.click();
            reportEvent(true);
          } else {
            if (statusEl) statusEl.textContent = 'The form changed before submitting. Review and submit it yourself.';
            reportEvent(false);
          }
          setTimeout(() => card.remove(), 2000);
          return;
        }
        if (num) num.textContent = String(remaining);
        if (ring) ring.style.strokeDashoffset = String(CIRC * (1 - remaining / AUTO_SUBMIT_COUNTDOWN_SECONDS));
        if (sub) sub.textContent = `${fillResult.fields_filled} field${fillResult.fields_filled === 1 ? '' : 's'} filled. Auto-submits in ${remaining}s.`;
      }, 1000);
    }

    // ─── Workday account-creation speed-up (2026-07-03) ────────────────────────
    // Volley doesn't create the account itself, and only ever fills the email field - password,
    // clicking Create Account, and completing email verification are entirely the student's own
    // steps by explicit product decision. Not a fill-and-stop-with-countdown card like the
    // others: there's no button to auto-submit toward, since the form is never actually
    // complete without the password the student is meant to type themselves.

    function accountCreationCardShell(): string {
      return `
        <div style="
          position: relative;
          background: white; border: 1.5px solid #e0e7ff; border-radius: 14px;
          padding: 16px 16px 14px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 13px; line-height: 1.4; box-shadow: 0 8px 32px rgba(79,70,229,0.18);
          width: 272px; box-sizing: border-box; animation: wp-slide-in 0.25s ease-out;
        ">
          <button id="wp-account-close" style="position:absolute;top:10px;right:12px;background:none;border:none;cursor:pointer;font-size:17px;opacity:0.4;color:#333;padding:0;line-height:1;">×</button>
          <div style="display:flex;align-items:flex-start;gap:9px;margin-bottom:12px;line-height:1.4;">
            <span style="font-size:20px;flex-shrink:0;margin-top:1px;line-height:1;">⚡</span>
            <div>
              <div style="font-weight:700;font-size:13px;color:#1e1b4b;line-height:1.4;">Fill in your email here?</div>
              <div style="font-size:12px;color:#6366f1;margin-top:2px;line-height:1.4;">You'll still set your own password and click Create Account.</div>
            </div>
          </div>
          <div id="wp-account-status" style="font-size:11px;color:#6b7280;margin-bottom:8px;display:none;line-height:1.4;"></div>
          <div style="display:flex;gap:8px;">
            <button id="wp-account-yes" style="
              flex:1;background:#4f46e5;color:white;border:none;border-radius:8px;
              padding:9px 0;font-size:12px;font-weight:600;cursor:pointer;
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            ">Yes, fill it</button>
            <button id="wp-account-no" style="
              flex:1;background:#f3f4f6;color:#374151;border:none;border-radius:8px;
              padding:9px 0;font-size:12px;font-weight:600;cursor:pointer;
              font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
            ">No thanks</button>
          </div>
        </div>
      `;
    }

    function injectWorkdayAccountCreationCard() {
      if (document.getElementById('volley-account-card')) return;
      const card = document.createElement('div');
      card.id = 'volley-account-card';
      card.innerHTML = accountCreationCardShell();
      getCardStack().appendChild(card);

      const dismiss = () => card.remove();
      card.querySelector('#wp-account-close')?.addEventListener('click', dismiss);
      card.querySelector('#wp-account-no')?.addEventListener('click', dismiss);
      card.querySelector('#wp-account-yes')?.addEventListener('click', () => {
        const statusEl = card.querySelector<HTMLElement>('#wp-account-status');
        const yesBtn = card.querySelector<HTMLButtonElement>('#wp-account-yes');
        if (yesBtn) yesBtn.disabled = true;
        if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Filling...'; }

        chrome.runtime.sendMessage(
          { type: 'GET_ACCOUNT_CREATION_DATA' },
          async (result: { error?: string; email?: string }) => {
            if (!result || result.error) {
              if (statusEl) statusEl.textContent = result?.error || 'Could not load your account data.';
              return;
            }
            const fillResult = await fillWorkdayAccountCreation({ email: result.email });

            chrome.runtime.sendMessage({
              type: 'AUTOFILL_EVENT',
              payload: {
                ats_name: 'workday',
                job_context: { company: 'account-creation', role: 'account-creation' },
                fields_filled: fillResult.fields_filled,
                fields_skipped: fillResult.fields_skipped,
                auto_submitted: false,
              },
            });

            if (statusEl) {
              statusEl.textContent = fillResult.fields_filled > 0
                ? 'Email filled. Set your own password and click Create Account when ready.'
                : 'No email on file yet - fill it in yourself, then set your password and click Create Account.';
            }
            setTimeout(dismiss, 6000);
          },
        );
      });
    }

    // Guidance for Workday's "Start Your Application" triage screen (Autofill with Resume /
    // Apply Manually / Use My Last Application) - previously Volley said nothing here, leaving
    // the student to guess which option leads anywhere useful. This just points them at the
    // right one and clicks it for them - pure page navigation, not a form submission or account
    // action, so it isn't gated behind the auto-submit toggle the way real submits are.
    function injectWorkdayStartScreenCard() {
      if (document.getElementById('volley-start-card')) return;
      const card = document.createElement('div');
      card.id = 'volley-start-card';
      card.innerHTML = `
        <div style="
          position: relative;
          background: white; border: 1.5px solid #e0e7ff; border-radius: 14px;
          padding: 16px 16px 14px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 13px; line-height: 1.4; box-shadow: 0 8px 32px rgba(79,70,229,0.18);
          width: 272px; box-sizing: border-box; animation: wp-slide-in 0.25s ease-out;
        ">
          <button id="wp-start-close" style="position:absolute;top:10px;right:12px;background:none;border:none;cursor:pointer;font-size:17px;opacity:0.4;color:#333;padding:0;line-height:1;">×</button>
          <div style="display:flex;align-items:flex-start;gap:9px;margin-bottom:12px;line-height:1.4;">
            <span style="font-size:20px;flex-shrink:0;margin-top:1px;line-height:1;">👋</span>
            <div>
              <div style="font-weight:700;font-size:13px;color:#1e1b4b;line-height:1.4;">This employer uses Workday</div>
              <div style="font-size:12px;color:#6b7280;margin-top:2px;line-height:1.4;">
                You'll need to sign in or create an account first - that part's still on you. Tap below
                and RoleQuick will take you to the right screen, then speed up account setup and the
                application from there.
              </div>
            </div>
          </div>
          <button id="wp-start-go" style="
            width:100%;background:#4f46e5;color:white;border:none;border-radius:8px;
            padding:9px 0;font-size:12px;font-weight:600;cursor:pointer;
            font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
          ">Take me there</button>
        </div>
      `;
      getCardStack().appendChild(card);

      card.querySelector('#wp-start-close')?.addEventListener('click', () => card.remove());
      card.querySelector('#wp-start-go')?.addEventListener('click', () => {
        const btn = findApplyManuallyButton();
        if (btn instanceof HTMLElement) btn.click();
        card.remove();
      });
    }

    // ─── Entry point ────────────────────────────────────────────────────────

    const KNOWN_ATS_HOSTS = [
      'linkedin.com', 'greenhouse.io', 'lever.co', 'myworkdayjobs.com',
      'workday.com', 'ashbyhq.com', 'indeed.com', 'joinhandshake.com',
    ];

    // Company-hosted application forms (vercel.com/careers, lifeatspotify.com, ...): this
    // only ever runs when the student explicitly injected the script from the popup, since
    // no manifest match covers these domains. Re-clicking the popup button re-enters here
    // via the __volleyGenericInit guard at the top of main().
    function genericInit() {
      if (KNOWN_ATS_HOSTS.some((k) => window.location.hostname.includes(k))) return;
      document.getElementById('volley-resume-card')?.remove();
      if (!isLikelyApplicationForm()) {
        const note = document.createElement('div');
        note.id = 'volley-generic-note';
        note.style.cssText =
          'position:fixed;bottom:72px;right:20px;z-index:2147483647;background:white;border:1.5px solid #e0e7ff;' +
          'border-radius:14px;padding:12px 16px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;' +
          'font-size:12px;line-height:1.4;color:#374151;box-shadow:0 8px 32px rgba(79,70,229,0.18);max-width:272px;';
        note.textContent = "RoleQuick couldn't find an application form on this page. Open the page with the actual form fields, then try again.";
        document.getElementById('volley-generic-note')?.remove();
        document.body.appendChild(note);
        setTimeout(() => note.remove(), 6000);
        return;
      }
      const job = getGenericJobDetails();
      injectResumeFillCard(job.title, job.company, extractGenericJdText, fillGenericApplication);
    }
    w.__volleyGenericInit = genericInit;

    function init() {
      const h = window.location.hostname;

      if (!KNOWN_ATS_HOSTS.some((k) => h.includes(k))) {
        genericInit();
        return;
      }

      if (h.includes('linkedin.com')) {
        const job = getJobDetails();
        if (job) watchLinkedInEasyApply(job.title, job.company);
        return;
      }

      const job = getJobDetails();
      if (!job) return;

      // Workday multi-stages within one "application" (triage modal -> sign-in/account
      // creation -> real form), and two of those stages need handling the generic
      // isApplicationPage() URL gate can't express: the triage screen appears as a modal over
      // the /details/... URL (no /apply anywhere yet - live-tested on NVIDIA 2026-07-04), and
      // the outreach action card should NOT fire on sign-in/account screens, where no job
      // title exists in the DOM and getJobDetails() falls back to site chrome
      // ("CAREERS AT NVIDIA"). So Workday routes stage-by-stage here and returns early.
      if (h.includes('myworkdayjobs.com') || h.includes('workday.com')) {
        if (isWorkdayApplicationPage()) {
          injectActionCard(job.title, job.company, window.location.href);
          watchSubmitButton(job.title, job.company, window.location.href);
          injectResumeFillCard(job.title, job.company, extractWorkdayJdText, fillWorkdayApplication);
        } else if (isWorkdayAccountCreationPage()) {
          injectWorkdayAccountCreationCard();
        } else if (isWorkdayStartScreen()) {
          injectWorkdayStartScreenCard();
        } else {
          chrome.runtime.sendMessage({
            type: 'JOB_DETECTED',
            payload: { title: job.title, company: job.company, url: window.location.href },
          });
        }
        return;
      }

      if (isApplicationPage()) {
        // Card 1: on form load
        injectActionCard(job.title, job.company, window.location.href);
        // Card 2: on submit click
        watchSubmitButton(job.title, job.company, window.location.href);
        // v2: resume-gen + fill-and-stop autofill (Section 7's build order: Lever, Greenhouse,
        // Ashby). isApplicationPage()/is<Ats>ApplicationPage() are evaluated against THIS frame's
        // own document, so for a cross-origin Greenhouse iframe embed, only the script instance
        // running inside that iframe ever sees a match here - it injects its own card and fills
        // its own DOM directly, no cross-frame messaging required.
        if (isLeverApplicationPage()) {
          injectResumeFillCard(job.title, job.company, extractLeverJdText, fillLeverApplication);
        } else if (isGreenhouseApplicationPage()) {
          injectResumeFillCard(job.title, job.company, extractGreenhouseJdText, fillGreenhouseApplication);
        } else if (isAshbyApplicationPage()) {
          injectResumeFillCard(job.title, job.company, extractAshbyJdText, fillAshbyApplication);
        }
      } else {
        // Job listing page: silently notify the popup so it can pre-fill fields
        chrome.runtime.sendMessage({
          type: 'JOB_DETECTED',
          payload: { title: job.title, company: job.company, url: window.location.href },
        });
      }
    }

    // Workday's stage-to-stage transitions (account creation -> real application form) are
    // where speed matters most for a "under a minute, end to end" goal - every other adapter
    // only needs to detect one stage per page load, but Workday needs to notice a stage change
    // that can happen without warning as soon as the student comes back from verifying their
    // email. Shorter delays here; the other ATSes keep the original, more conservative timing
    // since their pages don't multi-stage this way.
    const isWorkdayHost = window.location.hostname.includes('myworkdayjobs.com') || window.location.hostname.includes('workday.com');
    const INIT_DELAY_MS = isWorkdayHost ? 300 : 1000;
    const NAV_RECHECK_DELAY_MS = isWorkdayHost ? 250 : 800;

    setTimeout(init, INIT_DELAY_MS);

    // Re-run on SPA navigation
    let lastUrl = location.href;
    new MutationObserver(() => {
      const currentUrl = location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        cardInjected = false;
        approved = false;
        document.getElementById('volley-action-card')?.remove();
        document.getElementById('volley-submit-card')?.remove();
        document.getElementById('volley-resume-card')?.remove();
        document.getElementById('volley-account-card')?.remove();
        document.getElementById('volley-start-card')?.remove();
        setTimeout(init, NAV_RECHECK_DELAY_MS);
      }
    }).observe(document.body, { childList: true, subtree: true });

    // Workday specifically can swap stages (start screen -> account creation -> real
    // application form) without a URL change in some tenants (a same-path client-side
    // re-render rather than a navigation), which the MutationObserver above wouldn't catch via
    // its URL-diff check. A cheap poll (just DOM marker lookups) re-runs init() whenever none of
    // Volley's three Workday cards is currently showing, so a stage change gets picked up within
    // ~500ms instead of waiting for the next navigation event.
    if (isWorkdayHost) {
      // Poll for Workday's URL-less stage swaps, but not aggressively or forever: at 500ms this
      // re-ran init() (and its JOB_DETECTED message + storage write + badge update) twice a
      // second for the entire life of the tab. 1.5s is still well under human stage-change speed,
      // and we stop after a bounded window so an idle Workday tab left open doesn't poll all day.
      const WORKDAY_POLL_MS = 1500;
      const WORKDAY_POLL_MAX_MS = 5 * 60 * 1000;
      const startedAt = Date.now();
      const workdayPoll = setInterval(() => {
        if (Date.now() - startedAt > WORKDAY_POLL_MAX_MS) {
          clearInterval(workdayPoll);
          return;
        }
        if (
          !document.getElementById('volley-account-card') &&
          !document.getElementById('volley-resume-card') &&
          !document.getElementById('volley-start-card')
        ) {
          init();
        }
      }, WORKDAY_POLL_MS);
    }
  },
});
