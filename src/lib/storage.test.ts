import { beforeEach, describe, expect, it, vi } from 'vitest';

const values: Record<string, unknown> = {};
let storageError: string | null = null;

Object.defineProperty(globalThis, 'chrome', {
  configurable: true,
  value: {
    runtime: {
      get lastError() {
        return storageError ? { message: storageError } : undefined;
      },
    },
    storage: {
      local: {
        get: vi.fn((keys: string[], callback: (result: Record<string, unknown>) => void) => {
          callback(Object.fromEntries(keys.filter((key) => key in values).map((key) => [key, values[key]])));
        }),
        set: vi.fn((patch: Record<string, unknown>, callback: () => void) => {
          if (!storageError) Object.assign(values, patch);
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

const storage = await import('./storage');

describe('extension auth storage', () => {
  beforeEach(() => {
    for (const key of Object.keys(values)) delete values[key];
    storageError = null;
  });

  it('persists and reads back the sign-in token', async () => {
    await storage.setToken('token-123');
    await expect(storage.getToken()).resolves.toBe('token-123');
  });

  it('does not report onboarding success when Chrome rejects the write', async () => {
    storageError = 'Storage is unavailable';
    await expect(storage.setToken('token-123')).rejects.toThrow('Could not access extension storage');
  });

  it('keeps existing users signed in through the Volley key fallback', async () => {
    values.volley_token = 'legacy-token';
    await expect(storage.getToken()).resolves.toBe('legacy-token');
  });
});
