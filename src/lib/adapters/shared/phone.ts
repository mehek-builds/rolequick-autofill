// International phone splitting for forms that pair a country-code selector with a national
// number input (R-032's second defect). Greenhouse's new React form does this via intl-tel-input:
// typing the full stored "+971 567417451" into the NATIONAL number box made the widget reformat
// it as a UAE local number, "056 741 7451" - the employer receives a number with no country code
// that reads as unreachable, and for a US posting reads as a US number. The fix has to know what
// the +prefix means, drive the paired selector to that country, and put only the national
// significant number in the number box. Everything here is pure so it can be tested without DOM.

export interface InternationalPhone {
  // Digits of the dialing code, no plus: "971".
  dialCode: string;
  // National significant number, digits only, trunk zero stripped: "567417451".
  national: string;
  // ISO 3166-1 alpha-2 for the code, when known: "ae".
  iso2?: string;
  // Country display names to try against a selector's options, in preference order. Shared
  // codes list every plausible owner (+1 tries United States before Canada) so a name match can
  // still land when the options don't print dialing codes.
  countryNames: string[];
}

// Dialing code -> country. Not the world, deliberately: the long tail would mostly add ways to
// mis-map, and an unknown code degrades safely (splitInternationalPhone returns null, the caller
// falls back to whole-number behavior or flags the field). Codes are keyed as strings because
// they are matched longest-prefix-first against the digit run after "+".
const DIAL_CODES: Record<string, { iso2: string; names: string[] }> = {
  '1': { iso2: 'us', names: ['united states', 'usa', 'canada'] },
  '7': { iso2: 'ru', names: ['russia', 'kazakhstan'] },
  '20': { iso2: 'eg', names: ['egypt'] },
  '27': { iso2: 'za', names: ['south africa'] },
  '30': { iso2: 'gr', names: ['greece'] },
  '31': { iso2: 'nl', names: ['netherlands'] },
  '32': { iso2: 'be', names: ['belgium'] },
  '33': { iso2: 'fr', names: ['france'] },
  '34': { iso2: 'es', names: ['spain'] },
  '36': { iso2: 'hu', names: ['hungary'] },
  '39': { iso2: 'it', names: ['italy'] },
  '40': { iso2: 'ro', names: ['romania'] },
  '41': { iso2: 'ch', names: ['switzerland'] },
  '43': { iso2: 'at', names: ['austria'] },
  '44': { iso2: 'gb', names: ['united kingdom', 'uk', 'great britain'] },
  '45': { iso2: 'dk', names: ['denmark'] },
  '46': { iso2: 'se', names: ['sweden'] },
  '47': { iso2: 'no', names: ['norway'] },
  '48': { iso2: 'pl', names: ['poland'] },
  '49': { iso2: 'de', names: ['germany'] },
  '51': { iso2: 'pe', names: ['peru'] },
  '52': { iso2: 'mx', names: ['mexico'] },
  '54': { iso2: 'ar', names: ['argentina'] },
  '55': { iso2: 'br', names: ['brazil'] },
  '56': { iso2: 'cl', names: ['chile'] },
  '57': { iso2: 'co', names: ['colombia'] },
  '60': { iso2: 'my', names: ['malaysia'] },
  '61': { iso2: 'au', names: ['australia'] },
  '62': { iso2: 'id', names: ['indonesia'] },
  '63': { iso2: 'ph', names: ['philippines'] },
  '64': { iso2: 'nz', names: ['new zealand'] },
  '65': { iso2: 'sg', names: ['singapore'] },
  '66': { iso2: 'th', names: ['thailand'] },
  '81': { iso2: 'jp', names: ['japan'] },
  '82': { iso2: 'kr', names: ['south korea', 'korea, republic'] },
  '84': { iso2: 'vn', names: ['vietnam', 'viet nam'] },
  '86': { iso2: 'cn', names: ['china'] },
  '90': { iso2: 'tr', names: ['turkey', 'türkiye'] },
  '91': { iso2: 'in', names: ['india'] },
  '92': { iso2: 'pk', names: ['pakistan'] },
  '94': { iso2: 'lk', names: ['sri lanka'] },
  '98': { iso2: 'ir', names: ['iran'] },
  '212': { iso2: 'ma', names: ['morocco'] },
  '213': { iso2: 'dz', names: ['algeria'] },
  '216': { iso2: 'tn', names: ['tunisia'] },
  '233': { iso2: 'gh', names: ['ghana'] },
  '234': { iso2: 'ng', names: ['nigeria'] },
  '254': { iso2: 'ke', names: ['kenya'] },
  '255': { iso2: 'tz', names: ['tanzania'] },
  '256': { iso2: 'ug', names: ['uganda'] },
  '351': { iso2: 'pt', names: ['portugal'] },
  '352': { iso2: 'lu', names: ['luxembourg'] },
  '353': { iso2: 'ie', names: ['ireland'] },
  '358': { iso2: 'fi', names: ['finland'] },
  '359': { iso2: 'bg', names: ['bulgaria'] },
  '370': { iso2: 'lt', names: ['lithuania'] },
  '371': { iso2: 'lv', names: ['latvia'] },
  '372': { iso2: 'ee', names: ['estonia'] },
  '380': { iso2: 'ua', names: ['ukraine'] },
  '381': { iso2: 'rs', names: ['serbia'] },
  '385': { iso2: 'hr', names: ['croatia'] },
  '386': { iso2: 'si', names: ['slovenia'] },
  '420': { iso2: 'cz', names: ['czech republic', 'czechia'] },
  '421': { iso2: 'sk', names: ['slovakia'] },
  '852': { iso2: 'hk', names: ['hong kong'] },
  '880': { iso2: 'bd', names: ['bangladesh'] },
  '886': { iso2: 'tw', names: ['taiwan'] },
  '960': { iso2: 'mv', names: ['maldives'] },
  '961': { iso2: 'lb', names: ['lebanon'] },
  '962': { iso2: 'jo', names: ['jordan'] },
  '964': { iso2: 'iq', names: ['iraq'] },
  '965': { iso2: 'kw', names: ['kuwait'] },
  '966': { iso2: 'sa', names: ['saudi arabia'] },
  '968': { iso2: 'om', names: ['oman'] },
  '970': { iso2: 'ps', names: ['palestine'] },
  '971': { iso2: 'ae', names: ['united arab emirates', 'uae'] },
  '972': { iso2: 'il', names: ['israel'] },
  '973': { iso2: 'bh', names: ['bahrain'] },
  '974': { iso2: 'qa', names: ['qatar'] },
  '975': { iso2: 'bt', names: ['bhutan'] },
  '976': { iso2: 'mn', names: ['mongolia'] },
  '977': { iso2: 'np', names: ['nepal'] },
  '994': { iso2: 'az', names: ['azerbaijan'] },
  '995': { iso2: 'ge', names: ['georgia'] },
  '998': { iso2: 'uz', names: ['uzbekistan'] },
};

/**
 * Split a stored phone into dialing code + national significant number, or null when the split
 * cannot be made SAFELY. Null is a real answer, not a failure: the caller must then either fill
 * the whole stored string (a form with one plain phone box, today's behavior) or refuse and flag
 * (a form whose widget would mangle it). It must never guess a split, because a wrong split
 * types a wrong number - the R-018/R-028 mis-fill class, worse than a blank.
 *
 * Rules:
 *  - only a "+"-prefixed value is split; anything else has no declared country and returns null;
 *  - the code is matched longest-prefix-first (3, then 2, then 1 digits) against the table, so
 *    "+971..." resolves to 971/UAE and never to 9 + "71...";
 *  - one leading trunk zero is stripped from the national part ("+971 0567..." is a common way
 *    students store it, and the trunk zero is not part of the international number);
 *  - a national part shorter than 4 digits is rejected as noise.
 */
export function splitInternationalPhone(stored: string): InternationalPhone | null {
  const trimmed = (stored ?? '').trim();
  if (!trimmed.startsWith('+')) return null;
  const digits = trimmed.slice(1).replace(/\D/g, '');
  if (digits.length < 5) return null;
  for (const len of [3, 2, 1]) {
    const code = digits.slice(0, len);
    const entry = DIAL_CODES[code];
    if (!entry) continue;
    let national = digits.slice(len);
    if (national.startsWith('0')) national = national.slice(1);
    if (national.length < 4) return null;
    return { dialCode: code, national, iso2: entry.iso2, countryNames: entry.names };
  }
  return null;
}

/**
 * The E.164 compact form of a split phone: "+" then dial code then national significant number,
 * no spaces or punctuation ("+971567417451"). This is the write for a phone box that a widget
 * wraps WITHOUT a drivable paired selector (Greenhouse CLASSIC's old intl-tel-input, the R-032
 * classic variant): the leading + and dial code travel with the digits, so the widget reads the
 * country from the value itself instead of reinterpreting the number as local, and a form that
 * submits the raw box value delivers the full international number either way. The trunk zero
 * is already gone by construction - splitInternationalPhone stripped it.
 */
export function toE164(phone: InternationalPhone): string {
  return `+${phone.dialCode}${phone.national}`;
}

// Escape a string for literal use inside a RegExp (option text is page-authored).
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pick the option of a country/code selector that matches the phone's country, or null when no
 * UNAMBIGUOUS match exists - in which case the caller must refuse the whole phone fill rather
 * than pick a near-miss (a wrong country code corrupts the number as surely as dropping it).
 *
 * Matching order, most to least specific:
 *  1. The dialing code printed in the option text ("United Arab Emirates (+971)", "+971"). The
 *     code must not be followed by another digit, so "+97" can never claim "+971..." entries.
 *  2. A country name on a word boundary ("United Arab Emirates" inside any longer text), tried
 *     in the table's preference order - this is what resolves shared codes like +1.
 *  3. The bare ISO code as the ENTIRE option text ("AE"), exact-only so a two-letter code can
 *     never match inside prose.
 * Every tier commits only on exactly one hit; two hits mean ambiguity, and ambiguity means null.
 */
export function matchCountryOption<T extends { text: string }>(
  options: T[],
  phone: InternationalPhone,
): T | null {
  const codeRe = new RegExp(`\\+\\s?${phone.dialCode}(?!\\d)`);
  const byCode = options.filter((o) => codeRe.test(o.text));
  if (byCode.length === 1) return byCode[0];

  for (const name of phone.countryNames) {
    const nameRe = new RegExp(`\\b${escapeRe(name)}\\b`, 'i');
    const byName = (byCode.length > 1 ? byCode : options).filter((o) => nameRe.test(o.text));
    if (byName.length === 1) return byName[0];
  }

  if (phone.iso2) {
    const byIso = options.filter((o) => o.text.trim().toLowerCase() === phone.iso2);
    if (byIso.length === 1) return byIso[0];
  }
  return null;
}
