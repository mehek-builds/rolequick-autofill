import type { ApplicationProfile } from '../types';

// Salary questions (R-031 + R-011), per Mehek's standing rule and her 2026-07-17 addition.
//
// ── The rule, in order of authority ──────────────────────────────────────────
// 1. A posting that STATES a salary range gets its MEDIAN, written the way the posting wrote the
//    range (same currency marker, same separators, same /hr suffix). The median is derived from
//    the posting's own numbers, so it is inherently currency-safe: no stored value is consulted
//    and nothing is ever converted. Sources for the stated range, most trusted first:
//      a. the salary question's own label / adjacent text ("USD 90,000 - 110,000");
//      b. Ashby's posting API compensation payload (structured currencyCode/minValue/maxValue -
//         the payload ashby.ts always fetched with includeCompensation=true and then dropped);
//      c. the JD text, but ONLY when unambiguous: a single stated range adjacent to
//         salary/compensation wording. Two different ranges, or none, resolve nothing.
// 2. No stated range -> the stored answer, gated:
//      - a stored PROSE answer ("Negotiable, open to your standard intern rate") is currency-free
//        and always safe in a free-text control, and must NEVER be typed into a numeric one;
//      - a stored BARE FIGURE is an ambiguity, not an answer (R-031's exact words). It fills ONLY
//        when the posting's currency is detectable AND matches desired_salary_currency. Anything
//        else - currency unknown, currency mismatch, currency unstated on our side - flags the
//        question for review, and the flag's "left for you" phrasing HOLDS auto-submit
//        (autosubmit-gate.ts REVIEW_FLAG). Never convert; a converted anchor is a number the
//        student never said.
//
// This module is pure (no DOM, no fetch) so the whole rule is unit-testable, and it is a LEAF
// module (imports only types) so background.ts can share the Ashby posting-API pieces without
// pulling the DOM-adjacent adapter graph into the service worker bundle.

// ─── Ashby posting API (shared with ashby.ts and background.ts) ──────────────

export interface AshbyPostingRef {
  org: string;
  postingId: string;
}

// `jobs.ashbyhq.com/espa/<uuid>[/application]` -> { org: 'espa', postingId: '<uuid>' }
// Moved here from ashby.ts (which re-exports it) so the background's compensation fetch can build
// the posting-API URL without importing the adapter.
export function parseAshbyPostingRef(url: string): AshbyPostingRef | null {
  try {
    const { hostname, pathname } = new URL(url);
    if (!hostname.includes('ashbyhq.com')) return null;
    const parts = pathname.split('/').filter(Boolean);
    const org = parts[0];
    const postingId = parts.find((p) => /^[0-9a-f-]{36}$/i.test(p));
    return org && postingId ? { org, postingId } : null;
  } catch {
    return null;
  }
}

// The one slice of the compensation payload the salary rule needs. Kept minimal on purpose: this
// is the shape that crosses the GENERATE_RESUME_AND_FILL_DATA message from background.ts to the
// adapter, and a fat passthrough of Ashby's whole object would make that message a moving target.
export interface PostingCompensation {
  currencyCode: string; // ISO 4217, uppercased ("USD")
  minValue: number;
  maxValue: number;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' ? (v as Rec) : null);

/**
 * Pull THIS posting's structured salary range out of the posting-API payload
 * (`?includeCompensation=true`), or null when it does not carry one usable range.
 *
 * Deliberately conservative: components are only usable with a currency code and finite positive
 * min/max; salary-typed components beat equity/bonus ones; and if what remains still spans more
 * than one distinct (currency, min, max) - a multi-tier US posting with per-city bands, say -
 * that is an AMBIGUITY, and the answer to an ambiguity is null, never "the first tier". A null
 * here just means the label/stored-value chain decides, exactly as on a board with no payload.
 */
export function selectPostingCompensation(payload: unknown, postingId: string): PostingCompensation | null {
  const jobs = rec(payload)?.jobs;
  if (!Array.isArray(jobs)) return null;
  const job = rec(
    jobs.find((j) => {
      const r = rec(j);
      return r !== null && (r.id === postingId || (typeof r.jobUrl === 'string' && r.jobUrl.includes(postingId)));
    }),
  );
  const comp = rec(job?.compensation);
  if (!comp) return null;

  const components: Rec[] = [];
  if (Array.isArray(comp.summaryComponents)) {
    for (const c of comp.summaryComponents) {
      const r = rec(c);
      if (r) components.push(r);
    }
  }
  if (Array.isArray(comp.compensationTiers)) {
    for (const t of comp.compensationTiers) {
      const tier = rec(t);
      if (!tier || !Array.isArray(tier.components)) continue;
      for (const c of tier.components) {
        const r = rec(c);
        if (r) components.push(r);
      }
    }
  }

  const usable = components.filter(
    (c) =>
      typeof c.currencyCode === 'string' &&
      c.currencyCode.trim() !== '' &&
      typeof c.minValue === 'number' &&
      Number.isFinite(c.minValue) &&
      c.minValue > 0 &&
      typeof c.maxValue === 'number' &&
      Number.isFinite(c.maxValue) &&
      c.maxValue >= c.minValue,
  );
  const salaries = usable.filter((c) => /salary/i.test(String(c.compensationType ?? '')));
  const pool = salaries.length > 0 ? salaries : usable;
  if (pool.length === 0) return null;

  const distinct = new Map<string, PostingCompensation>();
  for (const c of pool) {
    const pc: PostingCompensation = {
      currencyCode: (c.currencyCode as string).toUpperCase(),
      minValue: c.minValue as number,
      maxValue: c.maxValue as number,
    };
    distinct.set(`${pc.currencyCode}:${pc.minValue}:${pc.maxValue}`, pc);
  }
  if (distinct.size !== 1) return null;
  return [...distinct.values()][0];
}

// ─── Currency detection ──────────────────────────────────────────────────────

// Codes are matched case-insensitively because every adapter lowercases labels before matching.
// TRY, PHP and RON are deliberately ABSENT: lowercased they are ordinary words in the very text
// being scanned ("please try again", "PHP developer"), and a false currency resolution OPENS the
// stored-figure gate, which is exactly the wrong failure direction. Postings paying in those
// currencies simply stay on the flag path, which is safe.
const CURRENCY_CODES = [
  'usd', 'eur', 'gbp', 'aed', 'cad', 'aud', 'inr', 'sgd', 'chf', 'jpy', 'cny', 'hkd', 'nzd',
  'sek', 'nok', 'dkk', 'pln', 'czk', 'huf', 'brl', 'mxn', 'zar', 'krw', 'ils', 'sar', 'qar',
  'kwd', 'bhd', 'omr', 'myr', 'thb', 'idr', 'vnd', 'egp', 'ngn', 'kes', 'pkr', 'bdt', 'lkr',
];
const CODE_SRC = `\\b(${CURRENCY_CODES.join('|')})\\b`;
// Longest alternatives first so "us$" can never be consumed as "s$".
const SYMBOL_SRC = 'us\\$|ca\\$|au\\$|nz\\$|hk\\$|c\\$|a\\$|s\\$|[€£₹₩₺₪$]';
const CURRENCY_WORDS: Array<[RegExp, string]> = [
  [/\beuros?\b/i, 'EUR'],
  [/\bdirhams?\b/i, 'AED'],
  [/\bpounds?\s+sterling\b/i, 'GBP'],
  [/\bswiss\s+francs?\b/i, 'CHF'],
];

// Symbol or code -> ISO code, or null when the token resolves nothing. A bare "$" is a dollar of
// unknown nationality (USD? CAD? AUD?), so it deliberately maps to null: it counts as a currency
// MARKER when validating a stated range, but it can never satisfy the stored-figure gate.
function mapCurrencyToken(token: string): string | null {
  const t = token.trim().toLowerCase();
  switch (t) {
    case 'us$': return 'USD';
    case 'ca$': case 'c$': return 'CAD';
    case 'au$': case 'a$': return 'AUD';
    case 'nz$': return 'NZD';
    case 'hk$': return 'HKD';
    case 's$': return 'SGD';
    case '€': return 'EUR';
    case '£': return 'GBP';
    case '₹': return 'INR';
    case '₩': return 'KRW';
    case '₺': return 'TRY';
    case '₪': return 'ILS';
    case '$': return null;
    default:
      return CURRENCY_CODES.includes(t) ? t.toUpperCase() : null;
  }
}

function collectCurrencies(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(new RegExp(CODE_SRC, 'gi'))) {
    const c = mapCurrencyToken(m[1]);
    if (c) out.add(c);
  }
  for (const m of text.matchAll(new RegExp(SYMBOL_SRC, 'gi'))) {
    const c = mapCurrencyToken(m[0]);
    if (c) out.add(c);
  }
  for (const [re, code] of CURRENCY_WORDS) if (re.test(text)) out.add(code);
  return out;
}

/** Exactly one distinct currency named in the text, else null. Ambiguity never resolves. */
export function detectCurrency(text: string): string | null {
  const set = collectCurrencies(text);
  return set.size === 1 ? [...set].at(0)! : null;
}

/** The stored desired_salary_currency, normalised to an ISO code; unknown/unset -> null. */
export function normalizeStoredCurrency(currency: string | undefined): string | null {
  const c = currency?.trim();
  if (!c) return null;
  return mapCurrencyToken(c);
}

// ─── Stated salary ranges ────────────────────────────────────────────────────

export interface StatedRange {
  min: number;
  max: number;
  median: number;
  /** ISO code when the range names its currency unambiguously (a bare "$" does not). */
  currency: string | null;
  /** The median written the way the posting wrote the range: "USD 100,000", "$45/hr", "EUR 60.000". */
  fillText: string;
  /** The median as a bare number for numeric-only controls: "100000", "45". */
  fillNumeric: string;
}

interface NumToken {
  value: number;
  grouping: 'comma' | 'dot' | 'none';
}

// "90,000" (en grouping), "55.000" (EU grouping - the task's live EUR example), "90000", "42.5",
// "87,5" (EU decimal). Grouping requires groups of exactly three, so "42.5" stays a decimal.
function parseNumToken(raw: string): NumToken | null {
  const t = raw.trim();
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) return { value: Number(t.replace(/,/g, '')), grouping: 'comma' };
  if (/^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(t)) {
    return { value: Number(t.replace(/\./g, '').replace(',', '.')), grouping: 'dot' };
  }
  if (/^\d+(?:\.\d+)?$/.test(t)) return { value: Number(t), grouping: 'none' };
  if (/^\d+,\d{1,2}$/.test(t)) return { value: Number(t.replace(',', '.')), grouping: 'none' };
  return null;
}

function groupDigits(n: number, grouping: NumToken['grouping']): string {
  const int = Math.trunc(n);
  const frac = n - int;
  const sep = grouping === 'comma' ? ',' : grouping === 'dot' ? '.' : '';
  const grouped = sep ? String(int).replace(/\B(?=(\d{3})+(?!\d))/g, sep) : String(int);
  if (!frac) return grouped;
  const fracStr = String(Math.round(frac * 100) / 100).slice(2);
  return `${grouped}${grouping === 'dot' ? ',' : '.'}${fracStr}`;
}

const NUM_SRC = String.raw`\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?`;
// The hyphen family is written as escapes so this file carries no literal long-dash characters,
// while still matching the en/em dashes real postings use between the two numbers.
const SEP_SRC = String.raw`(?:\s*[-\u2010-\u2015~]\s*|\s+(?:to|and|bis)\s+)`;
const RANGE_SRC = `(${NUM_SRC})\\s*(k)?${SEP_SRC}(${NUM_SRC})\\s*(k)?`;

// The verbatim currency marker immediately before a range ("USD ", "$", "eur "), or ''.
// The 3-letter-code branch must both sit on a word boundary (so "husd 90,000" resolves nothing)
// and survive mapCurrencyToken (so "top 100-200" resolves nothing).
function currencyPrefixAt(text: string, index: number): string {
  const window = text.slice(Math.max(0, index - 8), index);
  const sym = new RegExp(`(?:${SYMBOL_SRC})\\s?$`, 'i').exec(window);
  if (sym) return sym[0];
  const code = /(?:^|[^a-z])([a-z]{3})(\s?)$/i.exec(window);
  if (code && mapCurrencyToken(code[1])) return code[1] + code[2];
  return '';
}

// The verbatim pay-interval suffix ("/hr", " per hour") and any trailing currency code
// ("55.000 - 65.000 EUR") immediately after a range.
function suffixAt(text: string, end: number): { unit: string; code: string } {
  const window = text.slice(end, end + 18);
  const unit =
    /^\s*(?:\/\s*(?:hr|hour|yr|year|mo|month|wk|week|annum)\b|\s?per\s+(?:hour|year|month|week|annum)\b)/i.exec(
      window,
    )?.[0] ?? '';
  const rest = window.slice(unit.length);
  const code = /^\s?([a-z]{3})\b/i.exec(rest);
  return { unit, code: code && mapCurrencyToken(code[1]) ? code[1] : '' };
}

/**
 * Every credible stated salary range in `text`, with the median pre-formatted in the posting's
 * own style. "Credible" is default-deny (the R-020 lesson: a matcher that fires on a number
 * anywhere is a mis-fill factory): a bare number pair only counts with a currency marker, a k
 * suffix, a pay-interval unit, or five-figure magnitude, and a year-shaped pair ("2024-2026")
 * never counts on magnitude alone.
 */
export function findStatedRanges(text: string): StatedRange[] {
  const out: StatedRange[] = [];
  for (const m of text.matchAll(new RegExp(RANGE_SRC, 'gi'))) {
    const minTok = parseNumToken(m[1]);
    const maxTok = parseNumToken(m[3]);
    if (!minTok || !maxTok) continue;
    const kMin = !!m[2];
    const kMax = !!m[4];
    // "90-110k" means 90k-110k: a k on one side scales an un-suffixed, un-grouped partner too.
    let min = minTok.value * (kMin || (kMax && !kMin && minTok.grouping === 'none' && minTok.value < 1000) ? 1000 : 1);
    let max = maxTok.value * (kMax || (kMin && !kMax && maxTok.grouping === 'none' && maxTok.value < 1000) ? 1000 : 1);
    if (!(min > 0) || max < min) continue;

    const idx = m.index ?? 0;
    const prefix = currencyPrefixAt(text, idx);
    const { unit, code: suffixCode } = suffixAt(text, idx + m[0].length);
    const k = kMin || kMax;
    const marker = prefix !== '' || suffixCode !== '' || k || unit !== '';
    if (!marker && min < 1000) continue;
    if (
      !marker &&
      Number.isInteger(min) &&
      Number.isInteger(max) &&
      min >= 1900 && min <= 2100 &&
      max >= 1900 && max <= 2100
    ) {
      continue; // a year pair, not a salary
    }

    const median = (min + max) / 2;
    const prefixTok = prefix.trim();
    const currency =
      (prefixTok ? mapCurrencyToken(prefixTok) : null) ?? (suffixCode ? mapCurrencyToken(suffixCode) : null);

    const grouping = maxTok.grouping !== 'none' ? maxTok.grouping : minTok.grouping;
    const medianStr = k ? `${String(median / 1000)}k` : groupDigits(median, grouping);
    // Codes are re-uppercased on the way out (labels arrive lowercased); symbols stay verbatim.
    const prefixOut = prefixTok
      ? /^[a-z]{3}$/i.test(prefixTok)
        ? prefixTok.toUpperCase() + (prefix.endsWith(' ') ? ' ' : '')
        : prefix
      : '';
    const suffixOut = !prefixOut && suffixCode ? ` ${suffixCode.toUpperCase()}` : '';
    // The range regex consumes trailing whitespace after the second number, so a word-led unit
    // ("per year") re-gains its separating space; "/hr" stays attached, as postings write it.
    const unitOut = unit && !/^[\s/]/.test(unit) ? ` ${unit}` : unit;
    out.push({
      min,
      max,
      median,
      currency,
      fillText: `${prefixOut}${medianStr}${unitOut}${suffixOut}`,
      fillNumeric: String(median),
    });
  }
  return out;
}

function dedupeRanges(ranges: StatedRange[]): StatedRange[] {
  const seen = new Map<string, StatedRange>();
  for (const r of ranges) seen.set(`${r.min}:${r.max}:${r.currency ?? ''}`, r);
  return [...seen.values()];
}

/** The single stated range in a salary question's own label/adjacent text, else null. */
export function statedRangeInLabel(label: string): StatedRange | null {
  const distinct = dedupeRanges(findStatedRanges(label));
  return distinct.length === 1 ? distinct[0] : null;
}

const SALARY_CONTEXT_SRC = 'salar|compensat|stipend|remunerat|\\bpay\\b|\\bwage\\b|hourly rate';

/**
 * The single stated range adjacent to salary/compensation wording in the JD text, else null.
 * "Adjacent" is a bounded window around the wording, and "single" is after dedupe: a JD naming
 * two different ranges resolves nothing, per the rule's own words ("parse only when unambiguous").
 */
export function statedRangeInJd(jd: string): StatedRange | null {
  const ranges: StatedRange[] = [];
  for (const m of jd.matchAll(new RegExp(SALARY_CONTEXT_SRC, 'gi'))) {
    const idx = m.index ?? 0;
    ranges.push(...findStatedRanges(jd.slice(Math.max(0, idx - 40), idx + 160)));
  }
  const distinct = dedupeRanges(ranges);
  return distinct.length === 1 ? distinct[0] : null;
}

/** The single currency named adjacent to salary wording in the JD text, else null. */
export function salaryAdjacentCurrencyInJd(jd: string): string | null {
  const found = new Set<string>();
  for (const m of jd.matchAll(new RegExp(SALARY_CONTEXT_SRC, 'gi'))) {
    const idx = m.index ?? 0;
    for (const c of collectCurrencies(jd.slice(Math.max(0, idx - 40), idx + 160))) found.add(c);
  }
  return found.size === 1 ? [...found].at(0)! : null;
}

// ─── The resolution ──────────────────────────────────────────────────────────

export type SalaryFieldShape = 'numeric' | 'freetext';

export interface SalaryQuestionContext {
  /** The question's own label / adjacent text (adapters pass their lowercased label). */
  label: string;
  /** 'numeric' for input[type=number] / numeric inputmode; 'freetext' for text inputs and textareas. */
  field: SalaryFieldShape;
  /** Page/JD text, for the unambiguous-JD-range and JD-currency sources (generic adapter). */
  jdText?: string;
  /** Ashby's structured compensation range, plumbed from the background fetch. */
  posting?: PostingCompensation | null;
}

export interface StoredSalary {
  value?: string;
  currency?: string;
}

export function storedSalaryOf(ap: ApplicationProfile): StoredSalary {
  return { value: ap.desired_salary, currency: ap.desired_salary_currency };
}

export type SalaryResolution =
  | { action: 'fill'; value: string; source: 'label-range' | 'posting-compensation' | 'jd-range' | 'stored-figure' | 'stored-prose' }
  | { action: 'flag'; reason: string };

// "left for" is load-bearing: autosubmit-gate's REVIEW_FLAG matches it, so every salary flag
// HOLDS the auto-submit countdown, and "left for you" keeps it on the card's "Still needs you"
// list (selectNeedsYouReasons). Same contract as linkSkipReason / locationSkipReason.
export function salarySkipReason(label: string, detail: string): string {
  return `salary question left for you (${detail}): "${label.slice(0, 60)}"`;
}

/** Anything that is not a bare figure ("80000", "80,000", "80k") counts as prose. */
export function isProseSalary(value: string): boolean {
  return !/^[\d\s.,]+k?$/i.test(value.trim());
}

// A stored bare figure shaped for the control: numeric controls reject grouped digits, so
// "80,000" / "80k" become "80000"; free text keeps the student's own formatting.
function storedFigureFor(value: string, numeric: boolean): string {
  const trimmed = value.trim();
  if (!numeric) return trimmed;
  const compact = trimmed.replace(/\s+/g, '');
  const k = /k$/i.test(compact);
  const tok = parseNumToken(k ? compact.slice(0, -1) : compact);
  return tok ? String(tok.value * (k ? 1000 : 1)) : trimmed;
}

/**
 * The one salary decision, per the authority order at the top of this file. Always returns a
 * fill or a flag, never "not my problem": a salary question that falls through to generic paths
 * is how R-031 shipped a figure across currencies in the first place.
 */
export function resolveSalary(ctx: SalaryQuestionContext, stored: StoredSalary): SalaryResolution {
  const numeric = ctx.field === 'numeric';

  // 1a. The question's own label states the range.
  const labelRange = statedRangeInLabel(ctx.label);
  if (labelRange) {
    return { action: 'fill', source: 'label-range', value: numeric ? labelRange.fillNumeric : labelRange.fillText };
  }

  // 1b. Ashby's structured compensation payload states it.
  if (ctx.posting) {
    const median = (ctx.posting.minValue + ctx.posting.maxValue) / 2;
    return {
      action: 'fill',
      source: 'posting-compensation',
      value: numeric ? String(median) : `${ctx.posting.currencyCode} ${groupDigits(median, 'comma')}`,
    };
  }

  // 1c. The JD text states exactly one range next to salary wording.
  if (ctx.jdText) {
    const jdRange = statedRangeInJd(ctx.jdText);
    if (jdRange) {
      return { action: 'fill', source: 'jd-range', value: numeric ? jdRange.fillNumeric : jdRange.fillText };
    }
  }

  // 2. No stated range: the stored answer, gated.
  const value = stored.value?.trim();
  if (!value) {
    return { action: 'flag', reason: salarySkipReason(ctx.label, 'no salary answer in your profile') };
  }

  if (isProseSalary(value)) {
    if (numeric) {
      return {
        action: 'flag',
        reason: salarySkipReason(ctx.label, 'this field takes a number and your stored answer is a sentence'),
      };
    }
    return { action: 'fill', source: 'stored-prose', value };
  }

  // A bare figure: only with the posting's currency detected AND matching the stored one.
  const postingCurrency = detectCurrency(ctx.label) ?? (ctx.jdText ? salaryAdjacentCurrencyInJd(ctx.jdText) : null);
  const storedCurrency = normalizeStoredCurrency(stored.currency);
  if (!postingCurrency) {
    return {
      action: 'flag',
      reason: salarySkipReason(ctx.label, "couldn't confirm the posting's currency for your stored figure"),
    };
  }
  if (!storedCurrency || storedCurrency !== postingCurrency) {
    return {
      action: 'flag',
      reason: salarySkipReason(
        ctx.label,
        `the posting pays in ${postingCurrency} and your stored figure is ${storedCurrency ?? 'in no stated currency'}, never converted`,
      ),
    };
  }
  return { action: 'fill', source: 'stored-figure', value: storedFigureFor(value, numeric) };
}
