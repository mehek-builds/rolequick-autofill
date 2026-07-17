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
    expect(isPhoneLabel('Number', declared({ autocomplete: 'tel' }))).toBe(true);
    expect(isPhoneLabel('Contact', declared({ name: 'phone' }))).toBe(true);
    expect(isPhoneLabel('Contact', declared({ id: 'candidate-mobile' }))).toBe(true);
    expect(isPhoneLabel('Number of referrals', declared({ name: 'referral_count' }))).toBe(false);
  });
});
