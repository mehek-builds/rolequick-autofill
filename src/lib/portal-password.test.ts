import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mirrors storage.test.ts's chrome.storage.local stub: portal-password.ts reads its salt through
// storage.ts, so the derivation can't run at all without working extension storage. Node's own
// WebCrypto backs crypto.subtle here, so this file deliberately stays on the default node
// environment rather than opting into jsdom (whose crypto is only partially implemented).
const values: Record<string, unknown> = {};

Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  value: {
    runtime: {
      get lastError() {
        return undefined;
      },
    },
    storage: {
      local: {
        get: vi.fn((keys: string[], callback: (result: Record<string, unknown>) => void) => {
          callback(Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, values[key]])));
        }),
        set: vi.fn((patch: Record<string, unknown>, callback: () => void) => {
          Object.assign(values, patch);
          callback();
        }),
        remove: vi.fn((keys: string | string[], callback: () => void) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
          callback();
        }),
      },
    },
  },
});

const { derivePortalPassword, portalKeyForHost } = await import('./portal-password');
const storage = await import('./storage');

const TENANT = 'acme.myworkdayjobs.com';

describe('portalKeyForHost', () => {
  it('strips a www. prefix so one tenant never derives two different passwords', () => {
    expect(portalKeyForHost('www.acme.myworkdayjobs.com')).toBe(TENANT);
  });

  it('lowercases the host', () => {
    expect(portalKeyForHost('ACME.MyWorkdayJobs.com')).toBe(TENANT);
  });
});

describe('derivePortalPassword', () => {
  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
  });

  it('is deterministic: the same tenant always re-derives the same password', async () => {
    // The load-bearing property. Litos stores no password at rest, so logging the student back in
    // later works only if this is reproducible from the salt plus the hostname.
    const first = await derivePortalPassword(TENANT);
    expect(await derivePortalPassword(TENANT)).toBe(first);
  });

  it('derives a different password per tenant so one portal breach cannot open the rest', async () => {
    const acme = await derivePortalPassword(TENANT);
    expect(await derivePortalPassword('globex.myworkdayjobs.com')).not.toBe(acme);
  });

  it('treats www. and case variants of one tenant as the same account', async () => {
    const plain = await derivePortalPassword(TENANT);
    expect(await derivePortalPassword('www.acme.myworkdayjobs.com')).toBe(plain);
    expect(await derivePortalPassword('ACME.MyWorkdayJobs.com')).toBe(plain);
  });

  it('satisfies Workday complexity classes by construction', async () => {
    // Guaranteed by the trailing digit/special/Aa, not by luck in the random slice, so a strict
    // tenant can never reject the generated password.
    const password = await derivePortalPassword(TENANT);
    expect(password).toHaveLength(18);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[!@#$%*?]/);
  });

  it('really depends on the salt: a reinstall derives a different password', async () => {
    const before = await derivePortalPassword(TENANT);
    for (const key of Object.keys(values)) delete values[key]; // cleared storage / fresh install
    expect(await derivePortalPassword(TENANT)).not.toBe(before);
  });

  it('generates the salt once rather than regenerating it per call', async () => {
    await derivePortalPassword(TENANT);
    const salt = values.litos_portal_salt;
    expect(salt).toBeTypeOf('string');
    await derivePortalPassword('globex.myworkdayjobs.com');
    expect(values.litos_portal_salt).toBe(salt);
  });

  it('keeps the salt through logout so accounts Litos created stay reachable', async () => {
    // clearAll() must never orphan a portal account: drop the salt and the password for every
    // tenant the student ever applied to becomes unreproducible, locking them out for good.
    const before = await derivePortalPassword(TENANT);
    await storage.clearAll();
    expect(await derivePortalPassword(TENANT)).toBe(before);
  });
});
