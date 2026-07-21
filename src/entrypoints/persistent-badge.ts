export default defineContentScript({
  // Same job-portal list as content.ts. Was <all_urls>, which forces the
  // "read and change all your data on all websites" install warning and the
  // slowest Chrome Web Store review queue.
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
    if (
      window.location.protocol === 'chrome:' ||
      window.location.protocol === 'chrome-extension:' ||
      document.getElementById('rolequick-persistent')
    ) return;

    const el = document.createElement('div');
    el.id = 'rolequick-persistent';
    el.innerHTML = `
      <div id="rolequick-persistent-btn" style="
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 2147483645;
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: #4f46e5;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: 0 2px 12px rgba(79,70,229,0.35);
        opacity: 0.55;
        transition: opacity 0.2s, transform 0.2s;
        font-size: 17px;
        user-select: none;
      " title="Litos">🔥</div>
      <div id="rolequick-persistent-tip" style="
        display: none;
        position: fixed;
        bottom: 68px;
        right: 16px;
        z-index: 2147483645;
        background: #1e1b4b;
        color: white;
        border-radius: 8px;
        padding: 8px 12px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 12px;
        max-width: 190px;
        text-align: center;
        line-height: 1.4;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
        pointer-events: none;
      ">Click the Litos icon in your toolbar to draft outreach emails</div>
    `;
    document.body.appendChild(el);

    const btn = el.querySelector<HTMLElement>('#rolequick-persistent-btn')!;
    const tip = el.querySelector<HTMLElement>('#rolequick-persistent-tip')!;

    btn.addEventListener('mouseenter', () => {
      btn.style.opacity = '1';
      btn.style.transform = 'scale(1.1)';
      tip.style.display = 'block';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.opacity = '0.55';
      btn.style.transform = 'scale(1)';
      tip.style.display = 'none';
    });
  },
});
