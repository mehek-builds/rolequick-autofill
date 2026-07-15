import type { Profile } from './types';

// Storage keys. The product was renamed from Volley to RoleQuick after it shipped to the
// Chrome Web Store, so every persisted key now has a new `rolequick_*` name alongside the
// original `volley_*` name it may already exist under in an installed user's
// chrome.storage.local. To avoid orphaning saved profiles/tokens/settings across a published
// update: reads prefer the new key and fall back to the legacy one; writes only ever touch the
// new key; clears remove BOTH names (so a fallback read cannot resurrect a cleared value); and
// migrateLegacyStorage() does a one-time copy old -> new. No update should lose user data.
const TOKEN_KEY = 'rolequick_token';
const PROFILE_KEY = 'rolequick_profile';
const AUTO_SUBMIT_KEY = 'rolequick_auto_submit_enabled';

const LEGACY_TOKEN_KEY = 'volley_token';
const LEGACY_PROFILE_KEY = 'volley_profile';
const LEGACY_AUTO_SUBMIT_KEY = 'volley_auto_submit_enabled';

// Each current key paired with the legacy key it superseded, for migration and fallback.
const KEY_PAIRS: ReadonlyArray<readonly [current: string, legacy: string]> = [
  [TOKEN_KEY, LEGACY_TOKEN_KEY],
  [PROFILE_KEY, LEGACY_PROFILE_KEY],
  [AUTO_SUBMIT_KEY, LEGACY_AUTO_SUBMIT_KEY],
];

const ALL_KEYS: string[] = KEY_PAIRS.flatMap(([current, legacy]) => [current, legacy]);

// Prefer the new key; fall back to the legacy Volley-era key so an existing install that has
// not migrated yet still reads its saved value.
function chromeStorageGetCompat<T>(key: string, legacyKey: string): Promise<T | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([key, legacyKey], (result) => {
      const current = result[key] as T | undefined;
      resolve(current ?? (result[legacyKey] as T | undefined) ?? null);
    });
  });
}

function chromeStorageSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

function chromeStorageRemove(keys: string | string[]): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, resolve);
  });
}

// One-time copy of any legacy Volley-era value into its new key when the new key is absent.
// Safe to call on every startup: it writes only when the new key is missing and the legacy key
// is present, and it leaves the legacy value in place as a fallback (clears remove both names).
export async function migrateLegacyStorage(): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.storage.local.get(ALL_KEYS, (result) => {
      const patch: Record<string, unknown> = {};
      for (const [current, legacy] of KEY_PAIRS) {
        if (result[current] === undefined && result[legacy] !== undefined) {
          patch[current] = result[legacy];
        }
      }
      if (Object.keys(patch).length === 0) {
        resolve();
        return;
      }
      chrome.storage.local.set(patch, () => resolve());
    });
  });
}

export async function getToken(): Promise<string | null> {
  return chromeStorageGetCompat<string>(TOKEN_KEY, LEGACY_TOKEN_KEY);
}

export async function setToken(token: string): Promise<void> {
  return chromeStorageSet(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  // Remove both names so the legacy-key fallback in getToken() cannot bring a cleared token back.
  return chromeStorageRemove([TOKEN_KEY, LEGACY_TOKEN_KEY]);
}

export async function getProfile(): Promise<Profile | null> {
  return chromeStorageGetCompat<Profile>(PROFILE_KEY, LEGACY_PROFILE_KEY);
}

export async function setProfile(profile: Profile): Promise<void> {
  return chromeStorageSet(PROFILE_KEY, profile);
}

export async function clearAll(): Promise<void> {
  // Logout clears the token and profile (both new and legacy names). The auto-submit
  // preference is intentionally left in place, matching the original logout behavior.
  await chromeStorageRemove([TOKEN_KEY, LEGACY_TOKEN_KEY, PROFILE_KEY, LEGACY_PROFILE_KEY]);
}

// Off by default: fill-and-stop (highlight Submit, student clicks) unless the student has
// explicitly opted in to the cancelable auto-submit countdown in the extension popup.
export async function getAutoSubmitEnabled(): Promise<boolean> {
  return (await chromeStorageGetCompat<boolean>(AUTO_SUBMIT_KEY, LEGACY_AUTO_SUBMIT_KEY)) ?? false;
}

export async function setAutoSubmitEnabled(enabled: boolean): Promise<void> {
  return chromeStorageSet(AUTO_SUBMIT_KEY, enabled);
}
