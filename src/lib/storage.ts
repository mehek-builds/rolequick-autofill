import type { Profile } from './types';

// Litos is the current product name. RoleQuick and Volley keys remain read-only migration
// aliases so an extension update never signs out an existing user or loses their settings.
const TOKEN_KEY = 'litos_token';
const PROFILE_KEY = 'litos_profile';
const AUTO_SUBMIT_KEY = 'litos_auto_submit_enabled';

const TOKEN_ALIASES = ['rolequick_token', 'volley_token'] as const;
const PROFILE_ALIASES = ['rolequick_profile', 'volley_profile'] as const;
const AUTO_SUBMIT_ALIASES = ['rolequick_auto_submit_enabled', 'volley_auto_submit_enabled'] as const;

const KEY_GROUPS: ReadonlyArray<readonly [current: string, ...aliases: string[]]> = [
  [TOKEN_KEY, ...TOKEN_ALIASES],
  [PROFILE_KEY, ...PROFILE_ALIASES],
  [AUTO_SUBMIT_KEY, ...AUTO_SUBMIT_ALIASES],
];

const ALL_KEYS: string[] = KEY_GROUPS.flatMap((group) => [...group]);

// Prefer the new key; fall back to the legacy Volley-era key so an existing install that has
// not migrated yet still reads its saved value.
function lastStorageError(): Error | null {
  const message = chrome.runtime.lastError?.message;
  return message ? new Error(`Could not access extension storage: ${message}`) : null;
}

function chromeStorageGetCompat<T>(key: string, aliases: readonly string[]): Promise<T | null> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key, ...aliases], (result) => {
      const error = lastStorageError();
      if (error) {
        reject(error);
        return;
      }
      const current = result[key] as T | undefined;
      const migrated = aliases.map((alias) => result[alias] as T | undefined).find((value) => value !== undefined);
      resolve(current ?? migrated ?? null);
    });
  });
}

function chromeStorageSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      const error = lastStorageError();
      if (error) reject(error);
      else resolve();
    });
  });
}

function chromeStorageRemove(keys: string | string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const error = lastStorageError();
      if (error) reject(error);
      else resolve();
    });
  });
}

// One-time copy of any legacy Volley-era value into its new key when the new key is absent.
// Safe to call on every startup: it writes only when the new key is missing and the legacy key
// is present, and it leaves the legacy value in place as a fallback (clears remove both names).
export async function migrateLegacyStorage(): Promise<void> {
  await new Promise<void>((resolve) => {
    chrome.storage.local.get(ALL_KEYS, (result) => {
      const patch: Record<string, unknown> = {};
      for (const [current, ...aliases] of KEY_GROUPS) {
        const migrated = aliases.map((alias) => result[alias]).find((value) => value !== undefined);
        if (result[current] === undefined && migrated !== undefined) {
          patch[current] = migrated;
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
  return chromeStorageGetCompat<string>(TOKEN_KEY, TOKEN_ALIASES);
}

export async function setToken(token: string): Promise<void> {
  await chromeStorageSet(TOKEN_KEY, token);
  if ((await getToken()) !== token) throw new Error('Your sign-in could not be saved. Please try again.');
}

export async function clearToken(): Promise<void> {
  // Remove both names so the legacy-key fallback in getToken() cannot bring a cleared token back.
  return chromeStorageRemove([TOKEN_KEY, ...TOKEN_ALIASES]);
}

export async function getProfile(): Promise<Profile | null> {
  return chromeStorageGetCompat<Profile>(PROFILE_KEY, PROFILE_ALIASES);
}

export async function setProfile(profile: Profile): Promise<void> {
  await chromeStorageSet(PROFILE_KEY, profile);
  if (!(await getProfile())) throw new Error('Your profile could not be saved. Please try again.');
}

export async function clearAll(): Promise<void> {
  // Logout clears the token and profile (both new and legacy names). The auto-submit
  // preference is intentionally left in place, matching the original logout behavior.
  await chromeStorageRemove([TOKEN_KEY, ...TOKEN_ALIASES, PROFILE_KEY, ...PROFILE_ALIASES]);
}

// Off by default: fill-and-stop (highlight Submit, student clicks) unless the student has
// explicitly opted in to the cancelable auto-submit countdown in the extension popup.
export async function getAutoSubmitEnabled(): Promise<boolean> {
  return (await chromeStorageGetCompat<boolean>(AUTO_SUBMIT_KEY, AUTO_SUBMIT_ALIASES)) ?? false;
}

export async function setAutoSubmitEnabled(enabled: boolean): Promise<void> {
  return chromeStorageSet(AUTO_SUBMIT_KEY, enabled);
}
