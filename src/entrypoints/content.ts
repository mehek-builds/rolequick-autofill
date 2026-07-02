import { isLeverApplicationPage, extractLeverJdText, fillLeverApplication } from '../lib/adapters/lever';
import { isGreenhouseApplicationPage, extractGreenhouseJdText, fillGreenhouseApplication } from '../lib/adapters/greenhouse';
import { isAshbyApplicationPage, extractAshbyJdText, fillAshbyApplication } from '../lib/adapters/ashby';
import { isWorkdayApplicationPage, extractWorkdayJdText, fillWorkdayApplication } from '../lib/adapters/workday';
import { isLinkedInApplicationPage, extractLinkedInJdText, fillLinkedInApplication } from '../lib/adapters/linkedin';
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
        const title =
          document.querySelector<HTMLElement>('h1.app-title')?.textContent?.trim() ??
          document.querySelector<HTMLElement>('h1')?.textContent?.trim();
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
      if (h.includes('ashbyhq.com')) return path.includes('/apply');
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

      function attachListener() {
        if (watched) return;
        const btn = findSubmitButton();
        if (!btn) return;
        watched = true;

        btn.addEventListener('click', () => {
          if (approved) return; // Already drafting from card 1
          // Remove card 1 if still showing
          document.getElementById('volley-action-card')?.remove();
          cardInjected = false;
          injectSubmitCard(title, company, url);
        });
      }

      // Try immediately, then watch for the button to appear (multi-step forms)
      attachListener();
      const observer = new MutationObserver(() => attachListener());
      observer.observe(document.body, { childList: true, subtree: true });
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

    function cardShell(headline: string, subline: string): string {
      return `
        <div style="
          position: fixed;
          bottom: 72px;
          right: 20px;
          z-index: 2147483647;
          background: white;
          border: 1.5px solid #e0e7ff;
          border-radius: 14px;
          padding: 16px 16px 14px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 13px;
          line-height: 1.4;
          box-shadow: 0 8px 32px rgba(79,70,229,0.18);
          max-width: 272px;
          animation: wp-slide-in 0.25s ease-out;
        ">
          <button id="wp-close" style="position:absolute;top:10px;right:12px;background:none;border:none;cursor:pointer;font-size:17px;opacity:0.4;color:#333;padding:0;line-height:1;">×</button>
          <div style="display:flex;align-items:flex-start;gap:9px;margin-bottom:12px;">
            <span style="font-size:20px;flex-shrink:0;margin-top:1px;">🔥</span>
            <div>
              <div style="font-weight:700;font-size:13px;color:#1e1b4b;">${headline}</div>
              <div style="font-size:12px;color:#6366f1;margin-top:2px;word-break:break-word;">${subline}</div>
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
              <div style="font-size:12px;color:#6366f1;margin-top:2px;">Open Volley when ready</div>
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
      document.body.appendChild(card);
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
      document.body.appendChild(card);
      attachCardHandlers(card, title, company, url);
    }

    // ─── v2: resume-gen + Lever autofill (fill-and-stop, never clicks Submit) ──────────

    function resumeFillCardShell(title: string, company: string): string {
      return `
        <div style="
          position: fixed; bottom: 72px; right: 306px; z-index: 2147483647;
          background: white; border: 1.5px solid #e0e7ff; border-radius: 14px;
          padding: 16px 16px 14px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          font-size: 13px; line-height: 1.4; box-shadow: 0 8px 32px rgba(79,70,229,0.18);
          max-width: 272px; animation: wp-slide-in 0.25s ease-out;
        ">
          <button id="wp-resume-close" style="position:absolute;top:10px;right:12px;background:none;border:none;cursor:pointer;font-size:17px;opacity:0.4;color:#333;padding:0;line-height:1;">×</button>
          <div style="display:flex;align-items:flex-start;gap:9px;margin-bottom:12px;">
            <span style="font-size:20px;flex-shrink:0;margin-top:1px;">📄</span>
            <div>
              <div style="font-weight:700;font-size:13px;color:#1e1b4b;">Generate tailored resume + fill this application?</div>
              <div style="font-size:12px;color:#6366f1;margin-top:2px;word-break:break-word;">${title} at ${company}</div>
            </div>
          </div>
          <div id="wp-resume-status" style="font-size:11px;color:#6b7280;margin-bottom:8px;display:none;"></div>
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
    }) => Promise<AutofillResult>;

    // Shared by every ATS adapter: generate the JD-tailored resume, then run that adapter's
    // client-side fill-and-stop. Only the JD-extraction and fill functions differ per ATS.
    function injectResumeFillCard(title: string, company: string, extractJdText: () => string, fill: FillFn) {
      if (document.getElementById('volley-resume-card')) return;
      const card = document.createElement('div');
      card.id = 'volley-resume-card';
      card.innerHTML = resumeFillCardShell(title, company);
      document.body.appendChild(card);

      const dismiss = () => card.remove();
      card.querySelector('#wp-resume-close')?.addEventListener('click', dismiss);
      card.querySelector('#wp-resume-no')?.addEventListener('click', dismiss);
      card.querySelector('#wp-resume-yes')?.addEventListener('click', async () => {
        const statusEl = card.querySelector<HTMLElement>('#wp-resume-status');
        const yesBtn = card.querySelector<HTMLButtonElement>('#wp-resume-yes');
        if (yesBtn) yesBtn.disabled = true;
        if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Tailoring your resume...'; }

        const jdText = extractJdText();

        chrome.runtime.sendMessage(
          { type: 'GENERATE_RESUME_AND_FILL_DATA', payload: { company, role: title, jd_text: jdText } },
          async (result: {
            error?: string;
            profile?: Profile;
            applicationProfile?: ApplicationProfile;
            resume?: { resume_url: string; file_name: string };
          }) => {
            if (!result || result.error || !result.profile || !result.applicationProfile || !result.resume) {
              if (statusEl) statusEl.textContent = result?.error || 'Could not generate a resume - fill this one manually.';
              return;
            }

            if (statusEl) statusEl.textContent = 'Filling the application...';

            let resumeBlob: Blob | undefined;
            try {
              const blobRes = await fetch(result.resume.resume_url);
              resumeBlob = await blobRes.blob();
            } catch {
              // No resume file available client-side; the adapter will skip the file input
              // and flag it rather than fail the whole fill.
            }

            // Safety net: a stuck field (an unexpected widget, a listener that never fires) must
            // never leave the student staring at "Filling the application..." forever with no
            // way to know what happened. 20s is generous for even a form with many custom
            // questions; if the adapter is still running past that, something is wrong and the
            // student needs to be told rather than left waiting silently.
            const FILL_TIMEOUT_MS = 20000;
            let fillResult: AutofillResult;
            try {
              fillResult = await Promise.race([
                fill({
                  fullName: result.profile.full_name ?? '',
                  profile: result.profile,
                  applicationProfile: result.applicationProfile,
                  resumeBlob,
                  resumeFileName: result.resume.file_name,
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
              runAutoSubmitCountdown(card, statusEl, submitBtn, fillResult, reportEvent);
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
          },
        );
      });
    }

    const AUTO_SUBMIT_COUNTDOWN_SECONDS = 8;

    // Opt-in only (AutofillSetupScreen toggle). Shows a cancelable countdown in the same card
    // rather than clicking Submit the instant the fill finishes, so a mis-filled field or a
    // second thought still has a window to stop it before anything real goes out.
    function runAutoSubmitCountdown(
      card: HTMLElement,
      statusEl: HTMLElement | null,
      submitBtn: HTMLElement,
      fillResult: AutofillResult,
      reportEvent: (autoSubmitted: boolean) => void,
    ) {
      const yesBtn = card.querySelector<HTMLButtonElement>('#wp-resume-yes');
      const noBtn = card.querySelector<HTMLButtonElement>('#wp-resume-no');
      if (yesBtn) yesBtn.style.display = 'none';

      let remaining = AUTO_SUBMIT_COUNTDOWN_SECONDS;
      let cancelled = false;

      const render = () => {
        if (statusEl) {
          statusEl.textContent = `Filled ${fillResult.fields_filled} field${fillResult.fields_filled === 1 ? '' : 's'}. Submitting in ${remaining}s - tap Cancel to review first.`;
        }
      };
      render();

      if (noBtn) {
        noBtn.textContent = 'Cancel';
        noBtn.onclick = () => {
          cancelled = true;
          clearInterval(interval);
          if (statusEl) statusEl.textContent = 'Cancelled. Review, then submit yourself.';
          submitBtn.style.outline = '3px solid #4f46e5';
          submitBtn.style.outlineOffset = '2px';
          reportEvent(false);
          setTimeout(() => card.remove(), 4000);
        };
      }

      const interval = setInterval(() => {
        remaining -= 1;
        if (cancelled) { clearInterval(interval); return; }
        if (remaining <= 0) {
          clearInterval(interval);
          if (statusEl) statusEl.textContent = 'Submitting...';
          submitBtn.click();
          reportEvent(true);
          setTimeout(() => card.remove(), 2000);
          return;
        }
        render();
      }, 1000);
    }

    // ─── Entry point ────────────────────────────────────────────────────────

    function init() {
      const h = window.location.hostname;

      if (h.includes('linkedin.com')) {
        const job = getJobDetails();
        if (job) watchLinkedInEasyApply(job.title, job.company);
        return;
      }

      const job = getJobDetails();
      if (!job) return;

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
        } else if (isWorkdayApplicationPage()) {
          // Fill-and-stop, same as the other three (2026-07-02: form-fill now runs on
          // Workday too). isWorkdayApplicationPage() itself is the "account already
          // exists" gate - it returns false during Workday's account-creation step, so
          // this card (and the fill it triggers) never appears before a real account
          // exists, only once the student has reached the actual application form.
          injectResumeFillCard(job.title, job.company, extractWorkdayJdText, fillWorkdayApplication);
        }
      } else {
        // Job listing page: silently notify the popup so it can pre-fill fields
        chrome.runtime.sendMessage({
          type: 'JOB_DETECTED',
          payload: { title: job.title, company: job.company, url: window.location.href },
        });
      }
    }

    setTimeout(init, 1000);

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
        setTimeout(init, 800);
      }
    }).observe(document.body, { childList: true, subtree: true });
  },
});
