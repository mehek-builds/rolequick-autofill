import { describe, it, expect } from 'vitest';
import { isPhoneLabel } from './shared/dom';

// R-020, found live 2026-07-17: Enpal's Ashby board labels its REQUIRED phone field just "Number".
// The matcher keyed on /\bphone\b/, so the field came back empty on a form where the profile HAD
// the number - the damaging class of non-fill, since RoleQuick advertises that field and had the
// data for it. The matrix below is the real one from the register.

const tel = () => ({ type: 'tel' }) as unknown as Element;
const text = () => ({ type: 'text' }) as unknown as Element;

describe('isPhoneLabel', () => {
  it('matches the labels seen live on real boards', () => {
    // Espa Labs and Perplexity, which always worked.
    expect(isPhoneLabel('Phone Number', tel())).toBe(true);
    expect(isPhoneLabel('Phone Number', text())).toBe(true);
    // Enpal, which did not. This is the regression.
    expect(isPhoneLabel('Number', tel())).toBe(true);
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
});
