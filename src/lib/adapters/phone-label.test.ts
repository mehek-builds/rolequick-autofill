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

// ─── Findings from the independent review of attempt 3 ───────────────────────────────────────
//
// Attempts 1-3 each fixed their own bug and created its opposite. These pin all three directions at
// once, so the next change has to satisfy every one of them.
describe('isPhoneLabel: default-deny, adjacency-scoped', () => {
  const tel = () => ({ type: 'tel' }) as unknown as Element;
  const text = () => ({ type: 'text' }) as unknown as Element;

  it('never hands her phone number to an ID field (severity 1)', () => {
    // The denylist could not enumerate the world's ID systems. Emirates ID is her own city; she
    // applies in the UK and India too. Every one of these returned TRUE before.
    for (const label of [
      'National Insurance number', 'Emirates ID number', 'Aadhaar number', 'PAN number',
      'Tax number', 'Fax number', 'Registration number', 'Matriculation number',
      'Bank account number', 'Passport number', 'Student Number', 'Employee number',
      'House number', 'Number of years of experience', 'Number of referrals',
      'Notice period (number of weeks)', 'Number of dependents',
    ]) {
      expect(isPhoneLabel(label, tel())).toBe(false);
    }
  });

  it('never fills a number that belongs to someone else (severity 1)', () => {
    // Rule 0 beats every tier: these carry a phone word and used to match on it.
    for (const label of [
      "Reference's phone number", 'Emergency contact phone', 'Emergency contact number',
      'Referee mobile', 'Next of kin phone number', 'Guardian phone',
    ]) {
      expect(isPhoneLabel(label, tel())).toBe(false);
      expect(isPhoneLabel(label, text())).toBe(false);
    }
  });

  it('an allowlisted word only counts when it TOUCHES the number word', () => {
    // The trap in a bag-of-words allowlist: "work" is a fine phone qualifier, and this is not a
    // phone field. Proved to fill her number under the naive allowlist.
    expect(isPhoneLabel('Number of hours you can work per week', tel())).toBe(false);
    expect(isPhoneLabel('Work number', tel())).toBe(true);
    expect(isPhoneLabel('Number of days you can work from home', tel())).toBe(false);
    expect(isPhoneLabel('Home number', tel())).toBe(true);
  });

  it('still fills every label from the live register matrix', () => {
    for (const label of ['Phone Number', 'Number', 'Mobile number', 'Number *', 'Nummer']) {
      expect(isPhoneLabel(label, tel())).toBe(true);
    }
    expect(isPhoneLabel('Phone Number', text())).toBe(true);
    expect(isPhoneLabel('Mobile number', text())).toBe(true);
  });

  it('fills the qualified and purpose-stated labels anchoring had broken', () => {
    for (const label of [
      'Contact number', 'Best number to reach you during the day',
      'Number where we can reach you during business hours',
      'Number (we will only use this to schedule interviews)',
      'Primary number', 'Alternate number', 'WhatsApp number',
      // NB: 'Personal number' is deliberately NOT here. It is the English personnummer, a national
      // ID, and losing it as a phone label is the trade we want. See the bare-tokens block below.
    ]) {
      expect(isPhoneLabel(label, tel())).toBe(true);
    }
  });

  it('does not read a place name as a phone field', () => {
    // `tel` in tier 1 fired on any control type: "Tel Aviv" on a plain text field got her number.
    expect(isPhoneLabel('Preferred office: Tel Aviv or Berlin', text())).toBe(false);
    expect(isPhoneLabel('Preferred office: Tel Aviv or Berlin', tel())).toBe(false);
    expect(isPhoneLabel('Which Tel Aviv team interests you?', text())).toBe(false);
  });
});

describe('isPhoneLabel: bare tokens that are NOT evidence of a phone', () => {
  const tel = () => ({ type: 'tel' }) as unknown as Element;

  it('does not read a German house number as a phone (regression I introduced)', () => {
    // German address forms are `Straße` + `Nr.`, and a house-number box is precisely the
    // numeric-keypad field that gets type="tel". `nr` was not in the original matcher
    // (number|nummer|tel|no); I added it mid-way through this work. On Enpal, the German board BOTH
    // R-014 and R-020 came from, this typed her phone number in as her house number.
    expect(isPhoneLabel('Nr', tel())).toBe(false);
    expect(isPhoneLabel('Nr.', tel())).toBe(false);
    expect(isPhoneLabel('Straße', tel())).toBe(false);
    expect(isPhoneLabel('Hausnummer', tel())).toBe(false);
  });

  it('still fills the tel-qualified abbreviations, which is what nr was there for', () => {
    for (const label of ['Tel Nr', 'Tel. Nr', 'Tel No', 'Tel', 'Nummer', 'Number']) {
      expect(isPhoneLabel(label, tel())).toBe(true);
    }
  });

  it('does not read a Nordic national ID as a phone', () => {
    // "Personal number" is the standard English rendering of personnummer. Swedish and Norwegian
    // boards ask for it in exactly those words, and `personal` was in the qualifier allowlist.
    expect(isPhoneLabel('Personal number', tel())).toBe(false);
    expect(isPhoneLabel('Personnummer', tel())).toBe(false);
    expect(isPhoneLabel('Personal identity number', tel())).toBe(false);
  });

  // R-028, found live on Ramp 2026-07-17, pre-merge. Every case above is a short FIELD LABEL.
  // Nobody had tested PROSE, which is the entire failure mode: rule 1 matched its phone word
  // anywhere in the string with no negative check, so a free-text engineering question was answered
  // with her phone number and would have been submitted.
  //
  // Rule 1 now asks where the phone word SITS: a field label names its field first, prose buries it
  // as a modifier. The pairs below are the point - each one holds two labels that a length cap or a
  // question-word list scores identically, and that position separates.
  describe('R-028: a phone word must HEAD the label to count', () => {
    it("does not type her phone number into Ramp's mobile-app question", () => {
      // The exact string from the live reproduction, on Ramp "Software Engineer Internship,
      // Android" (Ashby). type="text", so the type="tel" gate could never have saved this.
      const ramp =
        'Have you contributed to a mobile app(s) and/or several features that reached a large number of users?';
      expect(isPhoneLabel(ramp, text())).toBe(false);
      expect(isPhoneLabel(ramp, tel())).toBe(false);
    });

    it('still fills the real phone field on that same form', () => {
      // The fix is worthless if it buys correctness by breaking the field it exists to fill.
      // Ramp's genuine phone label is "Phone" on a type="text" control.
      expect(isPhoneLabel('Phone', text())).toBe(true);
    });

    it('rejects a question with no question mark and no interrogative word', () => {
      // Nothing here is keyed on '?' or on a list of question openers. These are all rejected
      // because their head is `do`/`have`/`which`/`years`/`link`, not a phone word.
      for (const label of [
        'Do you own a mobile device?',
        'Do you own a mobile device',
        'Have you shipped a mobile app',
        'Which mobile platforms have you worked with',
        'Years of mobile experience',
        'Link to your mobile app',
        'Your experience building mobile applications',
        'The largest mobile codebase you have ever owned',
      ]) {
        expect(isPhoneLabel(label, text())).toBe(false);
      }
    });

    it('rejects short prose that a length cap would have let through', () => {
      // All under 40 chars, no '?', no interrogative opener: invisible to the shape guard this
      // replaced, and every one of them would have typed her phone number into a free-text box.
      // `cell` is in the phone vocabulary, so a biotech posting is the same bug.
      for (const label of [
        'Mobile app experience',
        'Mobile app portfolio',
        'Mobile platforms used',
        'Mobile development experience',
        'Your mobile app store links',
        'Cell culture experience',
        'Cell line engineering experience',
      ]) {
        expect(isPhoneLabel(label, text())).toBe(false);
      }
    });

    it('is not fooled by hiding the question inside parentheses', () => {
      // The previous guard stripped parentheticals BEFORE looking for '?' and the opener, so all
      // three of these passed it. Position never looks at the tail, so there is nowhere to hide.
      for (const label of [
        'Mobile experience (how many users? which platforms?)',
        'Mobile development (React Native, Swift, Kotlin - which have you used?)',
        'Mobile (Have you shipped one? Tell us about the largest app you worked on.)',
      ]) {
        expect(isPhoneLabel(label, text())).toBe(false);
      }
    });

    it('is not fooled by list numbering in front of the question', () => {
      // A `^` anchor on the raw label is defeated by any leading artifact. Numbering is skipped, so
      // the head is still the real first word...
      for (const label of ['1. Do you own a mobile device', 'Q1: Do you own a mobile device']) {
        expect(isPhoneLabel(label, text())).toBe(false);
      }
      // ...and a numbered REAL phone field still fills.
      expect(isPhoneLabel('1. Phone number', text())).toBe(true);
      expect(isPhoneLabel('Q1: Phone number', text())).toBe(true);
    });

    it('fills a phone label that politely asks, which the opener list broke', () => {
      // `please` heads a request for a field, not a question about one. The previous guard rejected
      // all of these outright, and the last two are total non-fills since rule 3 needs a number word.
      for (const label of [
        'Please provide your phone number',
        'Please enter your mobile number',
        'Please provide your mobile phone number',
        'Please provide your cell phone',
        'Please add your mobile',
      ]) {
        expect(isPhoneLabel(label, text())).toBe(true);
      }
      // The discriminating pair: same opener, opposite answers, because `describe` is not a filler
      // so it becomes the head.
      expect(isPhoneLabel('Please describe your mobile experience', text())).toBe(false);
    });

    it('fills long phone labels that a 40-char cap killed', () => {
      for (const label of [
        'Mobile phone number where we can reach you during business hours',
        'Mobile Phone Number - Please include country code',
        'Your mobile telephone number including country code',
        'Mobile phone number for interview scheduling',
        'Phone number we should use to contact you',
        'Phone number to reach you on',
        'Mobile phone number (we only use this to schedule interviews)',
      ]) {
        expect(isPhoneLabel(label, text())).toBe(true);
      }
    });

    it('fills the German compound in prose, on Enpal, the board R-020 came from', () => {
      // A 50-char sentence headed by a compound that is its own number word. The cap rejected this
      // on BOTH text and tel, because PHONE_PURPOSE_RE is English-only and `telefonnummer` is not a
      // NUMBER_WORDS token, so rule 3 could not rescue it either.
      expect(isPhoneLabel('Telefonnummer, unter der wir Sie erreichen koennen', text())).toBe(true);
      expect(isPhoneLabel('Handynummer (mobil)', text())).toBe(true);
    });

    it('refuses a THIRD-PARTY phone label in German, not only in English', () => {
      // Caught in pre-merge review of this very branch. Rule 1's vocabulary was widened to German
      // for Enpal; rule 0's veto was not. So the English label was forbidden (asserted below) while
      // its German twin filled her personal number into an emergency-contact box, on the exact
      // board the German support exists for. Branch (b) returns on the head alone and never looks
      // at the tail, so ONLY rule 0 can stop these.
      for (const label of [
        'Telefonnummer des Notfallkontakts',
        'Telefonnummer der Referenzperson',
        'Telefonnummer Ihrer Referenz',
        'Handynummer des Notfallkontakts',
        'Mobilnummer Ihres Notfallkontakts',
        'Telnr des Notfallkontakts',
        'Telefonnummer des Erziehungsberechtigten',
        'Notfallnummer',
      ]) {
        expect(isPhoneLabel(label, text())).toBe(false);
        expect(isPhoneLabel(label, tel())).toBe(false);
      }
      // The English twins this branch already forbade, re-asserted as the pair.
      expect(isPhoneLabel('Phone number of your emergency contact', text())).toBe(false);
      expect(isPhoneLabel("Reference's phone number", text())).toBe(false);
    });

    it('still fills HER German phone label, which rule 0 must not swallow', () => {
      // The veto is deliberately broad, so this is the line it must not cross: these are her own
      // number, in the same language, and must keep filling.
      expect(isPhoneLabel('Telefonnummer, unter der wir Sie erreichen koennen', text())).toBe(true);
      expect(isPhoneLabel('Telefonnummer', text())).toBe(true);
      expect(isPhoneLabel('Handynummer (mobil)', text())).toBe(true);
      expect(isPhoneLabel('Mobilnummer', text())).toBe(true);
    });

    it('leaves every previously-passing label alone', () => {
      // The R-020 matrix, re-asserted through the new rule: it must cost nothing that already
      // worked, or it has traded one live bug for another.
      for (const label of ['Phone', 'Telephone', 'Mobile', 'Cell phone', 'Telefon', 'Handy', 'Telefonnummer']) {
        expect(isPhoneLabel(label, text())).toBe(true);
      }
      expect(isPhoneLabel('Phone Number', text())).toBe(true);
      expect(isPhoneLabel('Mobile number', text())).toBe(true);
      expect(isPhoneLabel('Mobile no', text())).toBe(true);
      expect(isPhoneLabel('Phone (required)', text())).toBe(true);
      expect(isPhoneLabel('Number', tel())).toBe(true);
      // Rule 0 still wins over a phone-headed label: not her number.
      expect(isPhoneLabel('Phone number of your emergency contact', text())).toBe(false);
    });
  });
});
