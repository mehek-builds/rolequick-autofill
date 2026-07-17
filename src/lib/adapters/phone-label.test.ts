import { describe, it, expect } from 'vitest';
import { isPhoneLabel } from './shared/dom';

// R-020, found live 2026-07-17: Enpal's Ashby board labels its REQUIRED phone field just "Number".
// The matcher keyed on /\bphone\b/, so the field came back empty on a form where the profile HAD
// the number - the damaging class of non-fill, since RoleQuick advertises that field and had the
// data for it. The matrix below is the real one from the register.

const tel = () => ({ type: 'tel' }) as unknown as Element;
const text = () => ({ type: 'text' }) as unknown as Element;

describe('isPhoneLabel', () => {
  // The full live matrix: 4 occurrences, 2 failing label variants, 2 companies. Only the exact
  // string "Phone Number" worked before, so this was never an Enpal quirk - it was a matcher
  // keying on the literal word "phone".
  it('matches every label seen live on a real board', () => {
    // Espa Labs and Perplexity, which always worked.
    expect(isPhoneLabel('Phone Number', tel())).toBe(true);
    expect(isPhoneLabel('Phone Number', text())).toBe(true);
    // Enpal Low-Code + Enpal Business Analytics. This is the original regression.
    expect(isPhoneLabel('Number', tel())).toBe(true);
    // Limetax Applied AI + Limetax Product Eng, found after the fix was written. Covered by the
    // unambiguous-word tier rather than the type="tel" gate, so it holds on a text control too.
    expect(isPhoneLabel('Mobile number', tel())).toBe(true);
    expect(isPhoneLabel('Mobile number', text())).toBe(true);
  });

  it('matches unambiguous phone words regardless of control type', () => {
    // Plenty of boards render a phone field as type="text", so these must not depend on the type.
    for (const label of ['Phone', 'Telephone', 'Mobile', 'Cell phone', 'Telefon', 'Handy']) {
      expect(isPhoneLabel(label, text())).toBe(true);
    }
  });

  it('does NOT read a bare "Number" as a phone on a non-tel control', () => {
    // The whole point of gating the widening on type="tel": "Number" alone is meaningless, and a
    // form asking for a student/employee/house number must not be handed her phone number.
    expect(isPhoneLabel('Number', text())).toBe(false);
    expect(isPhoneLabel('Student Number', text())).toBe(false);
    expect(isPhoneLabel('Number of years of experience', text())).toBe(false);
    expect(isPhoneLabel('Number', null)).toBe(false);
    expect(isPhoneLabel('Number', undefined)).toBe(false);
  });

  it('does not match unrelated labels', () => {
    expect(isPhoneLabel('Email', tel())).toBe(false);
    expect(isPhoneLabel('Full name', text())).toBe(false);
    expect(isPhoneLabel('LinkedIn URL', text())).toBe(false);
  });

  // type="tel" is NOT a phone signal on its own: forms set it on plain numeric fields purely to
  // summon the mobile numeric keypad. So the bare-number tier matches the WHOLE label, never a word
  // inside it - otherwise each of these hands her phone number to a field asking for something
  // else, which is the same wrong-data-on-a-real-application failure as the R-020 non-fill, just
  // arriving from the opposite direction.
  it('does not read a qualified "number" label as a phone, even on a tel control', () => {
    expect(isPhoneLabel('Number of years of experience', tel())).toBe(false);
    expect(isPhoneLabel('Student Number', tel())).toBe(false);
    expect(isPhoneLabel('Notice period (number of weeks)', tel())).toBe(false);
    expect(isPhoneLabel('House number', tel())).toBe(false);
    // `no` as a standalone token matched any label containing the word "no" at all.
    expect(isPhoneLabel('No', tel())).toBe(false);
    expect(isPhoneLabel('Do you have no notice period?', tel())).toBe(false);
  });

  it('still matches the bare and tel-qualified number labels the tier exists for', () => {
    for (const label of ['Number', 'Number *', 'Number:', 'Number (required)', 'Nummer', 'Tel', 'Tel No', 'Tel. Nr']) {
      expect(isPhoneLabel(label, tel())).toBe(true);
    }
  });

  it('trusts the control\'s own declaration over the label prose', () => {
    const declared = (attrs: Record<string, string>) =>
      ({ type: 'text', getAttribute: (k: string) => attrs[k] ?? null }) as unknown as Element;
    // autocomplete is spec-defined and is trusted, on any control type.
    expect(isPhoneLabel('Number', declared({ autocomplete: 'tel' }))).toBe(true);
    expect(isPhoneLabel('Anything at all', declared({ autocomplete: 'tel-national' }))).toBe(true);
    // name/id are NOT trusted: they are author prose in an attribute, so a stray "phone"/"mobile"
    // in an id would speak over the label entirely.
    expect(isPhoneLabel('How did you hear about us?', declared({ id: 'mobile-2' }))).toBe(false);
    expect(isPhoneLabel('Preferred contact time', declared({ name: 'phone_pref_window' }))).toBe(false);
    expect(isPhoneLabel('Number of referrals', declared({ name: 'referral_count' }))).toBe(false);
  });
});

// ─── Caught reviewing the R-020 fix itself ───────────────────────────────────────────────────
//
// Anchoring the bare-number tier on the WHOLE label traded R-020's non-fill for a different
// non-fill: every one of these had been filling before the "fix" and stopped. R-020 IS the
// non-fill bug, so the fix reintroduced the thing it exists to prevent, one door over.
describe('isPhoneLabel: labels the anchored version wrongly stopped filling', () => {
  const tel = () => ({ type: 'tel' }) as unknown as Element;

  it('fills a qualified or decorated number label on a tel control', () => {
    for (const label of [
      'Contact number',
      'Number (we will only use this to schedule interviews)',
      'Number ✱',
      'Number †',
      'Best number to reach you',
      'Primary number',
      'Number:',
      'Number *',
    ]) {
      expect(isPhoneLabel(label, tel())).toBe(true);
    }
  });

  it('still refuses a number label that says what the number is FOR', () => {
    // The disqualifier list is what replaces the anchoring. Each of these is a noun the label had
    // to spell out, which is exactly what a phone label never does.
    for (const label of [
      'Number of years of experience',
      'Student Number',
      'Employee number',
      'House number',
      'Notice period (number of weeks)',
      'Number of referrals',
      'Account number',
      'Passport number',
      'Number of dependents',
    ]) {
      expect(isPhoneLabel(label, tel())).toBe(false);
    }
  });

  it('reads German compound phone labels, which the board that caused R-020 uses', () => {
    // `\btelefon\b` cannot match inside a compound, so these were missed outright. Enpal is German.
    for (const label of ['Telefonnummer', 'Handynummer', 'Mobilnummer', 'Telefon', 'Handy']) {
      expect(isPhoneLabel(label, tel())).toBe(true);
      expect(isPhoneLabel(label, { type: 'text' } as unknown as Element)).toBe(true);
    }
  });

  it('does not let the German suffix widen into unrelated words', () => {
    // The trailing \b is why the suffixes are spelled out instead of the boundary dropped.
    for (const label of ['Mobility preferences', 'Handyman experience', 'Hotel booking reference']) {
      expect(isPhoneLabel(label, tel())).toBe(false);
    }
  });
});

describe('autocomplete is a token list, not a value', () => {
  const withAc = (v: string) => ({ type: 'text', getAttribute: (k: string) => (k === 'autocomplete' ? v : null) }) as unknown as Element;
  it('reads the spec-legal token forms', () => {
    // Grammar: [section-*] [shipping|billing] [home|work|mobile|fax|pager] tel. "home tel" is THE
    // canonical way to mark a home phone; anchoring the whole attribute rejected all of these.
    for (const v of ['tel', 'tel-national', 'tel-local', 'home tel', 'work tel', 'shipping tel', 'section-blue billing tel']) {
      expect(isPhoneLabel('Contact', withAc(v))).toBe(true);
    }
  });
  it('does not fire on unrelated autocomplete tokens', () => {
    for (const v of ['', 'off', 'email', 'street-address', 'given-name', 'postal-code']) {
      expect(isPhoneLabel('Contact', withAc(v))).toBe(false);
    }
  });
});

describe('German abbreviations kept alongside the compounds', () => {
  const tel = () => ({ type: 'tel' }) as unknown as Element;
  it('matches the abbreviated German forms', () => {
    for (const l of ['Telnr', 'Telefonnr', 'Tel Nr', 'Telefonnummer']) {
      expect(isPhoneLabel(l, tel())).toBe(true);
    }
  });
});
