import { getPortalSalt } from './storage';

// Deterministically derive a valid, reproducible password for a company job-portal account
// (Workday spins up a NEW account per tenant) from a per-install secret salt plus the tenant
// hostname. Same install + same host always yields the same password, so Litos can re-fill it to
// log the student back in for status checks or re-applies WITHOUT storing a password at rest.
// A breach of chrome.storage leaks the salt, not a usable per-site secret, and only for that one
// install.
//
// Reverses the 2026-07-03 "email only, student sets their own password" decision: that kept us out
// of custody but stranded every account behind a password Litos could never reproduce, breaking the
// one-profile-many-portals promise the moment a portal needs auth.

async function hmacSha256(saltB64: string, message: string): Promise<Uint8Array> {
  const keyBytes = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

// Normalize to the registrable tenant so www/subdomain quirks don't derive different passwords for
// the same account.
export function portalKeyForHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '');
}

// Short, non-reversing tag for the CURRENT salt. Stored alongside each account Litos provisions so
// a later fill can tell "this is the salt that set that password" from "the salt changed under us"
// (cross-tab generate race, storage cleared, different device). On mismatch the caller must skip the
// fill: re-deriving under a different salt yields a wrong password, and submitting wrong passwords
// is what locks a student out of their own Workday account.
export async function currentSaltFingerprint(): Promise<string> {
  const salt = await getPortalSalt();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt)));
  return btoa(String.fromCharCode(...digest)).replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
}

const SPECIALS = '!@#$%*?';

// 18 chars, guaranteed to satisfy Workday's classes (upper, lower, digit, special) BY CONSTRUCTION,
// so a strict tenant can't reject an otherwise-random slice.
export async function derivePortalPassword(hostname: string): Promise<string> {
  const salt = await getPortalSalt();
  const digest = await hmacSha256(salt, portalKeyForHost(hostname));
  const alnum = btoa(String.fromCharCode(...digest)).replace(/[^A-Za-z0-9]/g, '').slice(0, 14);
  const digit = String(digest[0] % 10);
  const special = SPECIALS[digest[1] % SPECIALS.length];
  return `${alnum}${digit}${special}Aa`;
}
