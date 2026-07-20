import { describe, it, expect } from 'vitest';
import { splitInternationalPhone, matchCountryOption, toE164 } from './phone';

// R-032's second defect, pure half: the split and the option match must be right BEFORE any DOM
// is involved, because a wrong split types a wrong number (the R-018/R-028 mis-fill class). The
// through-line of every case here: null is the safe answer, a guess never is.

describe('splitInternationalPhone', () => {
  it('splits the live R-032 number: +971 567417451', () => {
    // The exact stored value that intl-tel-input turned into "056 741 7451" on Cresta.
    expect(splitInternationalPhone('+971 567417451')).toEqual({
      dialCode: '971',
      national: '567417451',
      iso2: 'ae',
      countryNames: ['united arab emirates', 'uae'],
    });
  });

  it('resolves the longest code first, so +971 is never read as +9 + "71..."', () => {
    // There is no +9; but +1 vs +1x ordering is real: "+1 415..." must be US, not a 3-digit code.
    const us = splitInternationalPhone('+1 (415) 555-2671');
    expect(us?.dialCode).toBe('1');
    expect(us?.national).toBe('4155552671');
  });

  it('strips one trunk zero from the national part', () => {
    // "+971 0567417451" is a common way the number gets stored; the trunk 0 is not part of the
    // international number and typing it would re-create the exact mangle this fix removes.
    expect(splitInternationalPhone('+971 0567417451')?.national).toBe('567417451');
    // But only ONE zero: a national number legitimately containing zeros keeps them.
    expect(splitInternationalPhone('+44 07911 123456')?.national).toBe('7911123456');
  });

  it('refuses a number with no + prefix (no declared country, nothing to split)', () => {
    expect(splitInternationalPhone('0567417451')).toBeNull();
    expect(splitInternationalPhone('056 741 7451')).toBeNull();
  });

  it('refuses an unknown dialing code rather than guessing where it ends', () => {
    // +999 is unassigned; a guessed boundary would silently misread the number.
    expect(splitInternationalPhone('+999 12345678')).toBeNull();
  });

  it('refuses junk that is too short to be a phone number', () => {
    expect(splitInternationalPhone('+971 12')).toBeNull();
    expect(splitInternationalPhone('+')).toBeNull();
    expect(splitInternationalPhone('')).toBeNull();
  });
});

describe('matchCountryOption', () => {
  const uae = splitInternationalPhone('+971 567417451')!;

  it('matches by the dialing code printed in the option text', () => {
    const options = [
      { text: 'United States (+1)' },
      { text: 'United Arab Emirates (+971)' },
      { text: 'United Kingdom (+44)' },
    ];
    expect(matchCountryOption(options, uae)?.text).toBe('United Arab Emirates (+971)');
  });

  it('never lets a shorter code claim a longer one: +97 must not match +971 entries', () => {
    // (?!\d) is the guard: "+971" in an option is NOT a code-tier hit for a hypothetical "97".
    // The fixture's names are deliberately unmatchable so the name fallback cannot mask a code
    // tier that leaked.
    const fake = { dialCode: '97', national: '1567417451', countryNames: ['nowhereland'] };
    expect(matchCountryOption([{ text: 'United Arab Emirates (+971)' }], fake)).toBeNull();
  });

  it('falls back to the country name when options carry no codes', () => {
    const options = [{ text: 'India' }, { text: 'United Arab Emirates' }, { text: 'United States' }];
    expect(matchCountryOption(options, uae)?.text).toBe('United Arab Emirates');
  });

  it('resolves the shared +1 by name preference (United States before Canada)', () => {
    const one = splitInternationalPhone('+1 4155552671')!;
    const options = [{ text: 'Canada (+1)' }, { text: 'United States (+1)' }];
    // Both options carry +1, so the code tier is ambiguous; the name tier settles it, scoped to
    // the code-matching candidates so an unrelated option can't win.
    expect(matchCountryOption(options, one)?.text).toBe('United States (+1)');
  });

  it('returns null when nothing matches, so the caller refuses instead of near-missing', () => {
    const options = [{ text: 'United States (+1)' }, { text: 'India (+91)' }];
    expect(matchCountryOption(options, uae)).toBeNull();
  });

  it('matches a bare ISO code only as the entire option text', () => {
    expect(matchCountryOption([{ text: 'AE' }, { text: 'US' }], uae)?.text).toBe('AE');
    // "ae" inside prose must not match: two letters appear everywhere.
    expect(matchCountryOption([{ text: 'Aerial Systems Ltd' }], uae)).toBeNull();
  });
});

describe('toE164', () => {
  it('compacts the live R-032 number: code and digits, nothing else', () => {
    // The write for a widget-wrapped box with no drivable selector (Greenhouse CLASSIC): the
    // stored spacing is gone, the + and code are not.
    expect(toE164(splitInternationalPhone('+971 567417451')!)).toBe('+971567417451');
  });

  it('carries no trunk zero, because the split already stripped it', () => {
    // "+971 0567417451" written with its trunk zero IS the mangle shape; E.164 never has one.
    expect(toE164(splitInternationalPhone('+971 0567417451')!)).toBe('+971567417451');
    expect(toE164(splitInternationalPhone('+44 07911 123456')!)).toBe('+447911123456');
  });

  it('round-trips through the splitter to the same code and national number', () => {
    const split = splitInternationalPhone('+1 (415) 555-2671')!;
    expect(toE164(split)).toBe('+14155552671');
    expect(splitInternationalPhone(toE164(split))).toEqual(split);
  });
});
