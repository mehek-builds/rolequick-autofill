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
  it('is FALSE on a sign-in form, which has a single password input', () => {
    document.body.innerHTML = `
      <p>Sign in to your account</p>
      <input data-automation-id="email" type="email" />
      <input type="password" />`;
    expect(isWorkdayAccountCreationPage()).toBe(true);
    expect(isWorkdayCreateAccountStage()).toBe(false);
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
