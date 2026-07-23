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

const { derivePortalPassword, portalKeyForHost, currentSaltFingerprint } = await import('./portal-password');
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

  it('hands concurrent callers the same salt', async () => {
    // Two tabs can hit the generate-then-write window together. If they end up on different salts,
    // whichever account was provisioned under the loser gets a password nobody can re-derive.
    const [a, b, c] = await Promise.all([
      derivePortalPassword(TENANT),
      derivePortalPassword(TENANT),
      derivePortalPassword(TENANT),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('keeps the salt through logout so accounts Litos created stay reachable', async () => {
    // clearAll() must never orphan a portal account: drop the salt and the password for every
    // tenant the student ever applied to becomes unreproducible, locking them out for good.
    const before = await derivePortalPassword(TENANT);
    await storage.clearAll();
    expect(await derivePortalPassword(TENANT)).toBe(before);
  });
});

describe('salt fingerprint and provisioned-account records', () => {
  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
  });

  it('is stable for one salt and changes when the salt does', async () => {
    const first = await currentSaltFingerprint();
    expect(await currentSaltFingerprint()).toBe(first);
    for (const key of Object.keys(values)) delete values[key]; // reinstall
    expect(await currentSaltFingerprint()).not.toBe(first);
  });

  it('does not leak the salt itself', async () => {
    const fingerprint = await currentSaltFingerprint();
    expect(fingerprint).toHaveLength(12);
    expect(values.litos_portal_salt).not.toContain(fingerprint);
  });

  it('remembers which tenants Litos provisioned, and under which salt', async () => {
    const saltFingerprint = await currentSaltFingerprint();
    await storage.recordPortalAccount({ host: TENANT, saltFingerprint, createdAt: 1 });
    expect((await storage.getPortalAccounts())[TENANT]).toEqual({
      host: TENANT,
      saltFingerprint,
      createdAt: 1,
    });
  });

  it('keeps the first record for a host so salt drift stays detectable', async () => {
    // Overwriting on re-provision would stamp the CURRENT salt onto an account created under an
    // older one, which is exactly the mismatch the record exists to catch.
    await storage.recordPortalAccount({ host: TENANT, saltFingerprint: 'original0000', createdAt: 1 });
    await storage.recordPortalAccount({ host: TENANT, saltFingerprint: 'drifted00000', createdAt: 2 });
    expect((await storage.getPortalAccounts())[TENANT].saltFingerprint).toBe('original0000');
  });

  it('returns an empty map before anything is provisioned', async () => {
    expect(await storage.getPortalAccounts()).toEqual({});
  });
});
