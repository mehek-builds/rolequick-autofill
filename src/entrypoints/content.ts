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
  runAt: 'document_idle',
  main() {
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
          document.querySelector<HTMLElement>('.main-header-logo img')?.getAttribute('alt')?.trim() ??
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
        setTimeout(init, 800);
      }
    }).observe(document.body, { childList: true, subtree: true });
  },
});
