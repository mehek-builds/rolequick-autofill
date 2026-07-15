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
import { skippedReasonsNeedReview } from '../lib/autosubmit-gate';
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
      // Workday's final-step button has a stable id and no "submit" text, so match it directly.
      const workday = document.querySelector('[data-automation-id="bottom-navigation-next-button"]');
      if (workday) return workday;

      // Everything else: SCORE every button/submit-like control by what it says, rather than
      // taking the first `input[type=submit]`. Real forms often carry more than one submit-type
      // button - live-seen on vercel.com, an "Apply for Role" that opens/anchors the form near the
      // top AND the real "Submit Application" at the bottom, both `button[type=submit]`. A plain
      // querySelector returns the wrong (top) one. We also can't require type=submit, since Lever's
      // submit is a text button. So: score by label, exclude the obvious non-submits, and break
      // ties toward the control lower on the page (the real submit sits at the bottom).
      const controls = [
        ...document.querySelectorAll<HTMLElement>(
          'button, input[type="submit"], input[type="button"], [role="button"], a[role="button"]',
        ),
      ].filter((el) => !el.closest('[id*="volley"]') && el.offsetParent !== null);

      const EXCLUDE =
        /resume|cover\s*letter|\bsave\b|cancel|\bback\b|\bedit\b|sign\s*in|log\s*in|create account|\bupload\b|add another|remove|delete|\bsearch\b|ask ai|previous|learn more/i;
      let best: { el: Element; score: number } | null = null;
      for (let i = 0; i < controls.length; i++) {
        const el = controls[i];
        const label = `${el.textContent ?? ''} ${(el as HTMLInputElement).value ?? ''} ${el.getAttribute('aria-label') ?? ''}`
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        if (!label || label.length > 40 || EXCLUDE.test(label)) continue;
        let score = 0;
        if (/\bsubmit\b/.test(label)) score = 100;
        else if (/send (my |your )?application/.test(label)) score = 80;
        else if (/\bfinish\b|complete application/.test(label)) score = 60;
        else if (/apply for|apply now|^\s*apply\b/.test(label)) score = 40;
        if (score === 0) continue;
        if ((el as HTMLButtonElement).type === 'submit') score += 5;
        score += i / 1000; // tie-break toward the control lower in the DOM
        if (!best || score > best.score) best = { el, score };
      }
      return best ? best.el : null;
    }

    // A TRUE final-submit control, distinct from a "Next"/"Continue"/"Save and Continue"/"Review"
    // step-advance button. The auto-submit countdown must anchor to THIS, never a step button:
    // clicking a step button would advance a multi-step form (Workday's 5 pages) and then falsely
    // report the application as submitted. Returns null when the only actionable control is a
    // step-advance - i.e. a multi-step form that isn't on its final page yet, so there is nothing
    // to auto-submit toward.
    // Visible = has a layout box and isn't visibility:hidden. Unlike offsetParent !== null this keeps
    // a legitimately-visible position:fixed control (whose offsetParent is null) while still excluding
    // a display:none pre-rendered later-step button (and its descendants).
    function isElementVisible(el: HTMLElement): boolean {
      return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    }

    function findFinalSubmitButton(): HTMLElement | null {
      const STEP_ADVANCE = /\b(next|continue|save\s*(and|&)\s*continue|review|save\s+for\s+later|back)\b/i;
      const SUBMIT = /\bsubmit(\s+application)?\b|\bsend\s+application\b/i;
      const candidates = [
        ...document.querySelectorAll<HTMLElement>('button, input[type="submit"], [role="button"]'),
      ];
      for (const el of candidates) {
        if (el.closest('[id*="volley"]')) continue;
        if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') continue;
        // Must be visible: a multi-step form can pre-render a later step's "Submit" hidden in the
        // DOM; anchoring or firing on an off-screen button would submit a step the student can't see.
        if (!isElementVisible(el)) continue;
        // `||` not `??`: textContent is "" (not null) for a void <input type="submit">, so `??`
        // would never fall through to .value and classic Greenhouse's submit input would be missed.
        const text = (el.textContent || (el as HTMLInputElement).value || '').trim();
        if (!text) continue;
        // Skip a step-advance word ONLY when the text is not also a submit, so a final button
        // labelled "Review and Submit" / "Review & Submit application" still counts as a submit.
        if (STEP_ADVANCE.test(text) && !SUBMIT.test(text)) continue;
        if (SUBMIT.test(text)) return el;
      }
      return null;
    }

    // Is any on-screen required field still empty? Used to hold back auto-submit: the browser's own
    // validation would block the submit anyway, but by then we'd already have reported it as sent.
    function hasEmptyRequiredFields(): boolean {
      const req = [...document.querySelectorAll<HTMLElement>('[required], [aria-required="true"]')];
      for (const el of req) {
        if (el.closest('[id*="volley"]')) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const tag = el.tagName.toLowerCase();
        if (tag === 'input') {
          const inp = el as HTMLInputElement;
          // react-select comboboxes put aria-required on a visible input that stays value-empty
          // after a selection (the chosen value lives in component state / a hidden input), so an
          // empty .value there is NOT an unanswered field - skip it rather than wrongly holding
          // auto-submit on the work-auth/country/EEO controls Greenhouse and Ashby render this way.
          if (inp.getAttribute('role') === 'combobox' || inp.closest('[class*="select__control"], [class*="Select-control"]')) {
            // .value stays empty on a react-select even after a selection, so read the control
            // instead: a filled one renders a single/multi value node, an empty one a placeholder.
            // Only HOLD auto-submit when we can positively see it's empty; if we can't tell, skip it
            // as before so a genuinely filled control never wrongly blocks the submit.
            const control = inp.closest('[class*="select__control"], [class*="Select-control"]') ?? inp.parentElement;
            const hasValue = control?.querySelector(
              '[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"], [class*="Select-value"]',
            );
            const hasPlaceholder = control?.querySelector('[class*="placeholder"]');
            if (!hasValue && hasPlaceholder) return true;
            continue;
          }
          if (inp.type === 'checkbox' || inp.type === 'radio') {
            const group = inp.name
              ? [...document.querySelectorAll<HTMLInputElement>(`input[name="${CSS.escape(inp.name)}"]`)]
              : [inp];
            if (!group.some((g) => g.checked)) return true;
          } else if (!inp.value.trim() && !inp.files?.length) {
            return true;
          }
        } else if (tag === 'select') {
          if (!(el as HTMLSelectElement).value) return true;
        } else if (tag === 'textarea') {
          if (!(el as HTMLTextAreaElement).value.trim()) return true;
        }
      }
      return false;
    }

    // Field labels in skipped_reasons come from the page DOM, so escape before inserting via
    // innerHTML - a hostile <label> must not be able to inject markup into our card.
    function escapeHtml(s: string): string {
      return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
      );
    }

    // Show WHAT still needs the student, not just a filled count (the adapters compute a precise
    // skipped list that content.ts previously discarded). This is the difference between a form that
    // "looks done" and one where the student can see the resume, an agreement box, or a blank
    // required field still needs them before they submit.
    function renderFillSummary(
      statusEl: HTMLElement | null,
      fillResult: AutofillResult,
      opts: { resumeMissing: boolean; autoSubmitHeld: boolean },
    ): void {
      if (!statusEl) return;
      const head: string[] = [`Filled ${fillResult.fields_filled} field${fillResult.fields_filled === 1 ? '' : 's'}.`];
      if (opts.resumeMissing) head.push('⚠ Resume not attached - add it yourself.');
      if (opts.autoSubmitHeld) head.push('Auto-submit held: finish the flagged items, then submit.');
      // Keep the reasons that actually need a human: resume, agreements, unmatched/never-fill,
      // required blanks. Drop the resume line here (already surfaced above) and cap the list.
      const needsYou = fillResult.skipped_reasons
        .filter((r) => /agreement|never-fill|no matching|left for you|left blank|required|no unambiguous/i.test(r))
        .filter((r) => !/^resume:/i.test(r))
        .slice(0, 4);
      statusEl.style.display = 'block';
      statusEl.innerHTML =
        head.map((l) => `<div>${escapeHtml(l)}</div>`).join('') +
        (needsYou.length
          ? `<div style="margin-top:4px;font-weight:600;">Still needs you:</div>` +
            needsYou.map((r) => `<div>• ${escapeHtml(r)}</div>`).join('')
          : '') +
        `<div style="margin-top:4px;">Review, then submit yourself.</div>`;
    }

    // Result of the background resume-gen round trip, cached per job (company|role) for the tab's
    // life so a multi-step flow reuses step 1's resume instead of paying for - and being metered
    // for - a fresh generation on every step.
    type ResumeGenResult = {
      error?: string;
      profile?: Profile;
      applicationProfile?: ApplicationProfile;
      resume?: { resume_url: string; file_name: string };
    };
    const resumeGenByJob = new Map<string, Promise<ResumeGenResult>>();

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
      // JD is read at intent time (first hover/click), NOT at card injection, so a JD that
      // lazy-loads after the card appears is present when we tailor. Memoized so the gen call and
      // the essay-draft hook read the same JD text.
      let jdCache: string | null = null;
      const getJd = (): string => (jdCache ??= extractJdText());

      // Slightly longer than the background's own resume-fetch budget (60s) so its descriptive
      // error surfaces first; this is the backstop for the worse case where the service worker
      // is torn down and the callback never fires at all.
      const RESUME_GEN_TIMEOUT_MS = 65000;
      const jobKey = `${company} ${title}`;
      const startResumeGen = (): Promise<ResumeGenResult> => {
        const cached = resumeGenByJob.get(jobKey);
        if (cached) return cached; // reuse across steps of a multi-step application (no re-charge)
        const p = new Promise<ResumeGenResult>((resolve) => {
          let settled = false;
          const done = (r: ResumeGenResult) => {
            if (settled) return;
            settled = true;
            if (r.error) resumeGenByJob.delete(jobKey); // never cache a failure; let a retry re-run
            resolve(r);
          };
          const timer = setTimeout(
            () => done({ error: 'Resume generation timed out - fill this form manually.' }),
            RESUME_GEN_TIMEOUT_MS,
          );
          chrome.runtime.sendMessage(
            { type: 'GENERATE_RESUME_AND_FILL_DATA', payload: { company, role: title, jd_text: getJd() } },
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
        resumeGenByJob.set(jobKey, p);
        return p;
      };
      card.addEventListener('mouseenter', () => void startResumeGen(), { once: true });

      // If an auto-submit countdown is mid-flight, dismissing the card (the x or "No") must cancel
      // it too: the countdown's overlay and ticking interval live on document.body, OUTSIDE this
      // card, so just removing the card would leave them running and still fire ~15s later after the
      // student thought they'd dismissed everything. No-op when no countdown is active.
      const dismiss = () => { activeAutoSubmitCancel?.(); card.remove(); };
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
                    { type: 'ANSWER_QUESTION', payload: { company, role: title, jd_text: getJd(), question } },
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

        const autoSubmitOn = await getAutoSubmitEnabled();
        const finalSubmitBtn = findFinalSubmitButton();
        // Resume is "missing" if the blob never reached us (fetch failed upstream) or the adapter
        // reported it could not attach it. Never auto-submit an application with no resume.
        const resumeMissing = !resumeBlob || fillResult.skipped_reasons.some((r) => /^resume:/i.test(r));
        // Any answer the adapter AI-drafted must be read by the student before it goes out in their
        // name, so gate on the count the adapter now returns, not just a text match on the reasons.
        const aiDrafted = fillResult.ai_drafted > 0;
        // Items the adapter flagged as still needing the student (agreements, questions it could not
        // answer, never-fill/sensitive fields, dropdowns left for manual selection, answers left
        // blank). Classified by the pure skippedReasonsNeedReview() so it stays unit-tested. If the
        // fill flagged ANYTHING for review, hold auto-submit and hand back rather than submit unread.
        const needsReview = skippedReasonsNeedReview(fillResult.skipped_reasons);

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

        // Auto-submit is opt-in (AutofillSetupScreen toggle, off by default) AND only fires when it
        // is actually safe: a real FINAL-submit button exists (not a "Next"/"Continue" step button,
        // which would advance a multi-step form and then falsely report a submit), the resume
        // attached, and no required field is still empty (native validation would block the submit
        // anyway, after we'd already reported it sent). Otherwise fall through to highlight-and-
        // hand-back. It always fires from THIS student's own logged-in session, on data they
        // generated and can still cancel - never something Volley decides on its own.
        // document.hidden: never START a countdown while the student isn't looking at the tab (they
        // can't see the window to back out); going hidden mid-countdown is handled separately.
        const autoSubmitHeld =
          autoSubmitOn &&
          (!finalSubmitBtn || resumeMissing || aiDrafted || needsReview || hasEmptyRequiredFields() || document.hidden);
        if (autoSubmitOn && !autoSubmitHeld && finalSubmitBtn) {
          runAutoSubmitCountdown(
            card, statusEl,
            card.querySelector<HTMLButtonElement>('#wp-resume-yes'),
            card.querySelector<HTMLButtonElement>('#wp-resume-no'),
            finalSubmitBtn, fillResult, reportEvent, 'Submitting',
          );
          return;
        }

        reportEvent(false);

        // Surface WHAT still needs the student (resume, agreements, unmatched/required blanks), not
        // just a filled count - the adapters compute this precisely and it used to be discarded.
        renderFillSummary(statusEl, fillResult, { resumeMissing, autoSubmitHeld });

        // Highlight the real final-submit control if there is one; never click it here (PRD-v2
        // Section 5 Step 4). On a multi-step form still mid-flow there is no final submit yet, so
        // nothing is highlighted rather than pointing the student at a misleading "Next".
        if (finalSubmitBtn instanceof HTMLElement) {
          finalSubmitBtn.style.outline = '3px solid #4f46e5';
          finalSubmitBtn.style.outlineOffset = '2px';
        }

        setTimeout(dismiss, 9000);
      });
    }

    const AUTO_SUBMIT_COUNTDOWN_SECONDS = 15;

    // Cancel hook for an in-flight auto-submit countdown, exposed so SPA navigation (or any other
    // context change) can tear the countdown down. null whenever no countdown is running.
    let activeAutoSubmitCancel: (() => void) | null = null;

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
      // Tear down any countdown already running before standing up a new one. Combined with the SPA
      // navigation handler (which also calls this), there is never an orphaned interval/overlay or a
      // duplicate countdown firing behind this one. No-op the first time (handle starts null).
      activeAutoSubmitCancel?.();
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
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
        document.removeEventListener('input', onUserInteract, true);
        document.removeEventListener('pointerdown', onUserInteract, true);
        activeAutoSubmitCancel = null;
        overlay.remove();
      };

      const cancel = (msg = 'Cancelled. Review, then submit yourself.') => {
        if (cancelled) return;
        cancelled = true;
        clearInterval(interval);
        cleanupChrome();
        submitBtn.style.outline = '3px solid #4f46e5';
        submitBtn.style.outlineOffset = '2px';
        if (statusEl) statusEl.textContent = msg;
        reportEvent(false);
        setTimeout(() => card.remove(), 4000);
      };

      // Anything that changes the context the student was watching cancels the pending submit: the
      // Escape key, switching away from the tab (visibilitychange), the page unloading, or the
      // student editing the form (a real input event, or a pointerdown on a form control). Guarded
      // on isTrusted so the adapter's own programmatic fill events never trip it, and scoped to
      // ignore clicks on our own overlay.
      const isOurNode = (t: EventTarget | null) =>
        t instanceof Element && !!t.closest('#volley-autosubmit-overlay, [id*="volley"]');
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancel(); };
      // Going hidden does NOT cancel: the interval tick below freezes while document.hidden (it
      // never decrements or fires the click), so the countdown simply pauses and resumes when the
      // student returns. On return, re-anchor the panel since the layout may have shifted while away.
      const onVisibility = () => {
        if (!document.hidden) position();
      };
      const onPageHide = () => cancel();
      const onUserInteract = (e: Event) => {
        if (!e.isTrusted || isOurNode(e.target)) return;
        if (e.type === 'pointerdown') {
          const t = e.target;
          if (
            !(t instanceof Element) ||
            !t.closest('input, select, textarea, [role="combobox"], [role="listbox"], [role="option"], [contenteditable=""], [contenteditable="true"], [class*="select__control"], [class*="Select-control"]')
          )
            return;
        }
        cancel('You edited the form, so auto-submit was cancelled. Submit it yourself when ready.');
      };
      window.addEventListener('keydown', onKey);
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', onPageHide);
      document.addEventListener('input', onUserInteract, true);
      document.addEventListener('pointerdown', onUserInteract, true);
      // Let a SPA navigation elsewhere in the content script tear this countdown down too.
      activeAutoSubmitCancel = () =>
        cancel('The form navigated, so auto-submit was cancelled. Submit it yourself when ready.');
      overlay.querySelector('#wp-as-cancel')?.addEventListener('click', () => cancel());
      if (noBtn) { noBtn.textContent = 'Cancel'; noBtn.onclick = () => cancel(); }
      if (statusEl) {
        statusEl.textContent = `Filled ${fillResult.fields_filled} field${fillResult.fields_filled === 1 ? '' : 's'}. ${actionLabel} in ${remaining}s on the button - tap Cancel to review first.`;
      }

      const interval = setInterval(() => {
        if (cancelled) { clearInterval(interval); return; }
        // Freeze while the tab is hidden: never progress toward - or fire - a submit the student
        // can't see (no window in front of them to back out of). Resumes on the next tick once the
        // tab is visible again, so the countdown pauses rather than racing on in the background.
        if (document.hidden) return;
        remaining -= 1;
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
          // Reuse the anchored button only if it's still live AND visible (a re-render can hide its
          // step container via an ancestor display:none without detaching the button); otherwise
          // re-resolve (findFinalSubmitButton already returns only visible controls).
          const target = submitBtn.isConnected && isElementVisible(submitBtn) ? submitBtn : findFinalSubmitButton();
          // Re-validate at the instant of click: 15s is long enough for the form - or the tab - to
          // change under us. Fire ONLY when the target is still live AND visible, the tab is visible
          // AND focused (never submit into a background or blurred tab), and no required field is now
          // empty. Anything else hands back to the student instead of clicking.
          const tabActive = !document.hidden && document.hasFocus();
          if (
            target instanceof HTMLElement &&
            target.isConnected &&
            isElementVisible(target) &&
            tabActive &&
            !hasEmptyRequiredFields()
          ) {
            if (statusEl) statusEl.textContent = `${actionLabel}...`;
            target.click();
            reportEvent(true);
          } else {
            if (statusEl) {
              statusEl.textContent = tabActive
                ? 'The form changed before submitting. Review and submit it yourself.'
                : 'The tab was not in focus, so auto-submit was held. Come back and submit it yourself.';
            }
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
        // A navigation must kill any pending auto-submit countdown: the button it anchored to is
        // about to be torn down, and firing after the page changed could submit the wrong form.
        activeAutoSubmitCancel?.();
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
