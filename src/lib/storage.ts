import type { Profile } from './types';

const TOKEN_KEY = 'volley_token';
const PROFILE_KEY = 'volley_profile';

function chromeStorageGet<T>(key: string): Promise<T | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve((result[key] as T) ?? null);
    });
  });
}

function chromeStorageSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

function chromeStorageRemove(key: string): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.remove([key], resolve);
  });
}

export async function getToken(): Promise<string | null> {
  return chromeStorageGet<string>(TOKEN_KEY);
}

export async function setToken(token: string): Promise<void> {
  return chromeStorageSet(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  return chromeStorageRemove(TOKEN_KEY);
}

export async function getProfile(): Promise<Profile | null> {
  return chromeStorageGet<Profile>(PROFILE_KEY);
}

export async function setProfile(profile: Profile): Promise<void> {
  return chromeStorageSet(PROFILE_KEY, profile);
}

export async function clearAll(): Promise<void> {
  await chromeStorageRemove(TOKEN_KEY);
  await chromeStorageRemove(PROFILE_KEY);
}
