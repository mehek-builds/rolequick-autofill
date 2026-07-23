// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

// jsdom implements neither innerText nor a writable location, and workday.ts's stage detection
// reads both. Shim innerText onto textContent (equivalent for regex checks against form copy) and
// swap location for a real URL, which exposes the hostname/pathname the detector actually reads.
Object.defineProperty(HTMLElement.prototype, 'innerText', {
  configurable: true,
  get(this: HTMLElement) {
    return this.textContent ?? '';
  },
});

function setUrl(href: string): void {
  Object.defineProperty(window, 'location', { configurable: true, value: new URL(href) });
}

const APPLY_URL = 'https://acme.myworkdayjobs.com/en-US/careers/job/Engineer/apply';

const { isWorkdayCreateAccountStage, isWorkdayAccountCreationPage } = await import('./workday');

describe('isWorkdayCreateAccountStage', () => {
  beforeEach(() => {
    setUrl(APPLY_URL);
    document.body.innerHTML = '';
  });

  it('is true when Workday renders a confirm-password control', () => {
    document.body.innerHTML = `
      <input data-automation-id="email" type="email" />
      <input data-automation-id="password" type="password" />
      <input data-automation-id="verifyPassword" type="password" />`;
    expect(isWorkdayCreateAccountStage()).toBe(true);
  });

  it('is true when two password inputs render without the verifyPassword id', () => {
    document.body.innerHTML = '<input type="password" /><input type="password" />';
    expect(isWorkdayCreateAccountStage()).toBe(true);
  });

  // The safety case this whole split exists for. A returning student's sign-in form has exactly one
  // password box; typing a derived password there submits a WRONG password against an account Litos
  // may not have provisioned, and repeated wrong passwords lock the student out of their own Workday
  // account. The umbrella check still fires (the guidance card is useful on sign-in too) - only the
  // password offer is withheld.
  // Fixture copied from the real NVIDIA tenant (nvidia.wd5.myworkdayjobs.com, verified live
  // 2026-07-23), which is harsher than it looks: Workday's sign-in page carries a "Don't have an
  // account yet? Create Account" link, so the create-account TEXT is present on the very page we
  // must not treat as create-account. Only the single-password short-circuit running BEFORE the
  // text fallback keeps this false. Reorder those two checks and this test goes red - which is the
  // whole point of it, because the live failure mode is a locked-out student, not a red suite.
  // Email is type="text" on Workday, not type="email"; the honeypot is a real field on this form.
  it('is FALSE on a sign-in form, even though it links to Create Account', () => {
    document.body.innerHTML = `
      <p>Sign In</p>
      <input data-automation-id="email" type="text" />
      <input data-automation-id="password" type="password" />
      <input data-automation-id="beecatcher" type="text" />
      <p>Don't have an account yet? <a href="#">Create Account</a></p>`;
    expect(document.body.innerText).toMatch(/create account/i);
    expect(isWorkdayAccountCreationPage()).toBe(true);
    expect(isWorkdayCreateAccountStage()).toBe(false);
  });

  // The mirror of the above, also from the live NVIDIA create form: email is type="text", there is
  // an "I agree" checkbox (never touched), and the honeypot is present here too.
  it('is true on the real create-account fixture, honeypot and agreement box included', () => {
    document.body.innerHTML = `
      <p>Create Account</p>
      <input data-automation-id="email" type="text" />
      <input data-automation-id="password" type="password" />
      <input data-automation-id="verifyPassword" type="password" />
      <input data-automation-id="createAccountCheckbox" type="checkbox" />
      <input data-automation-id="beecatcher" type="text" />`;
    expect(isWorkdayCreateAccountStage()).toBe(true);
  });

  // Litos must never type into Workday's bot-trap field, on either form.
  it('never targets the beecatcher honeypot', () => {
    document.body.innerHTML = `
      <input data-automation-id="email" type="text" />
      <input data-automation-id="password" type="password" />
      <input data-automation-id="verifyPassword" type="password" />
      <input data-automation-id="beecatcher" type="text" />`;
    const emailTarget = document.querySelector('input[data-automation-id="email"], input[type="email"]');
    const passwordTargets = [
      ...document.querySelectorAll(
        'input[data-automation-id="password"], input[data-automation-id="verifyPassword"], input[type="password"]',
      ),
    ];
    expect(emailTarget?.getAttribute('data-automation-id')).toBe('email');
    expect(passwordTargets.map((el) => el.getAttribute('data-automation-id'))).toEqual([
      'password',
      'verifyPassword',
    ]);
  });

  it('falls back to create-account copy before any password field has rendered', () => {
    document.body.innerHTML = '<h1>Create Account</h1><input type="email" />';
    expect(isWorkdayCreateAccountStage()).toBe(true);
  });

  it('is false off a Workday host', () => {
    setUrl('https://boards.greenhouse.io/acme/jobs/1/apply');
    document.body.innerHTML = '<input type="password" /><input type="password" />';
    expect(isWorkdayCreateAccountStage()).toBe(false);
  });

  it('is false away from an apply URL', () => {
    setUrl('https://acme.myworkdayjobs.com/en-US/careers');
    document.body.innerHTML = '<input type="password" /><input type="password" />';
    expect(isWorkdayCreateAccountStage()).toBe(false);
  });
});
