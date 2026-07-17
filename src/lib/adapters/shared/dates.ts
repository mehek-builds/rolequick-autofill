// Date handling for ATS forms (R-014, found live 2026-07-17 on Enpal's Ashby board).
//
// Before this module there was NO date handling anywhere in the extension: `availability_date` was
// stored as an opaque string and handed straight to the filler, so whatever string onboarding
// captured got typed into whatever the ATS rendered. That is a locale landmine. Mehek is in Dubai
// (DD/MM/YYYY); most US-hosted ATS pickers are MM/DD/YYYY. Her stored "18/07/2026" parsed as
// month=18, which is invalid, so React's state stayed EMPTY while the DOM still displayed the
// text. The field looked answered to a human and to any DOM-level check, and the submit died on
// "Missing entry for required field" for a field that visibly had content.
//
// The failure mode is what makes this worth a module rather than a regex: no exception, no red
// field, no telemetry. So every write here is verified by reading the value back, and a write that
// does not round-trip is a reported skip, never a silent pass.

export interface DateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export type DateOrder = 'mdy' | 'dmy' | 'ymd';

const pad = (n: number) => String(n).padStart(2, '0');

function isRealDate({ year, month, day }: DateParts): boolean {
  if (month < 1 || month > 12 || day < 1 || year < 1900 || year > 2200) return false;
  // Rejects 31 April and 29 Feb on a common year: the Date round-trip only survives a real date.
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// Parse a stored profile string into date parts, or null if it is not an unambiguous date.
//
// Returning null is a FEATURE, not a shortfall. Two things must never happen: writing a non-date
// into a date field (the stored value is sometimes the free-text "Immediately" - see the term
// split in types.ts), and guessing at a genuinely ambiguous string. "03/04/2026" is 3 April in
// Dubai and 4 March in California, and nothing in the string says which; picking one would be
// exactly the silent wrong answer this module exists to prevent. Unambiguous inputs (ISO, or a
// slash form with a component > 12) resolve; anything else is left for the student.
export function parseStoredDate(raw: string | undefined | null): DateParts | null {
  const s = (raw ?? '').trim();
  if (!s) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) {
    const parts = { year: +iso[1], month: +iso[2], day: +iso[3] };
    return isRealDate(parts) ? parts : null;
  }

  const slash = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (slash) {
    const a = +slash[1];
    const b = +slash[2];
    const year = +slash[3];
    // Only resolvable when one component cannot be a month.
    if (a > 12 && b <= 12) {
      const parts = { year, month: b, day: a }; // dd/mm/yyyy
      return isRealDate(parts) ? parts : null;
    }
    if (b > 12 && a <= 12) {
      const parts = { year, month: a, day: b }; // mm/dd/yyyy
      return isRealDate(parts) ? parts : null;
    }
    return null; // ambiguous (both <= 12) - do not guess
  }

  return null;
}

export function formatDate(parts: DateParts, order: DateOrder): string {
  const { year, month, day } = parts;
  if (order === 'ymd') return `${year}-${pad(month)}-${pad(day)}`;
  if (order === 'dmy') return `${pad(day)}/${pad(month)}/${year}`;
  return `${pad(month)}/${pad(day)}/${year}`;
}

// Read the widget's expected order off the hints it already publishes. ATS date inputs almost
// always carry a mask in the placeholder ("MM/DD/YYYY") or spell the order out in the label
// ("(dd/mm/yyyy)" - ANYbotics does exactly this). Cheap, and beats probing when present.
export function detectDateOrder(el: Element | null | undefined): DateOrder | null {
  if (!el) return null;
  const input = el as HTMLInputElement;
  if (input.type === 'date') return 'ymd'; // input[type=date] is ISO by spec, regardless of display
  const hints = [
    input.getAttribute?.('placeholder'),
    input.getAttribute?.('aria-label'),
    input.getAttribute?.('title'),
    input.getAttribute?.('data-format'),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!hints) return null;
  if (/y{2,4}\s*[/.-]\s*m{1,2}\s*[/.-]\s*d{1,2}/.test(hints)) return 'ymd';
  if (/d{1,2}\s*[/.-]\s*m{1,2}\s*[/.-]\s*y{2,4}/.test(hints)) return 'dmy';
  if (/m{1,2}\s*[/.-]\s*d{1,2}\s*[/.-]\s*y{2,4}/.test(hints)) return 'mdy';
  return null;
}

// Does `written` still hold the date we meant after the widget got hold of it?
//
// This is the check the old code never had. A widget that rejected the value leaves the field
// empty (React state cleared), and one that accepted it may reformat it - both are handled by
// re-parsing what is actually in the box and comparing the parts, rather than string-comparing
// against what we typed.
export function valueHoldsDate(written: string, parts: DateParts, order: DateOrder): boolean {
  const s = written.trim();
  if (!s) return false; // rejected: the exact silent failure R-014 is about
  if (s === formatDate(parts, order)) return true;
  // Reformatted by the widget: accept any order that reads back as the same day.
  return (['ymd', 'dmy', 'mdy'] as DateOrder[]).some((o) => s === formatDate(parts, o));
}

// The orders to try, most-confident first.
//
// A detected order is used alone: the hint is the widget's own statement of what it wants.
//
// With no hint we can only sweep, and a read-back is NOT enough to make an arbitrary sweep safe. It
// proves the string is in the box; it does not prove the widget read it the way we meant. Hand a
// day-first widget our month-first "07/08/2026" and it reads 7 August, accepts it, and keeps our
// text verbatim - so the read-back passes while the form holds the wrong day, silently, which is
// the whole failure class this module exists to close. A slash write is only self-verifying when
// the date itself rules the other reading out:
//
//   day > 12       - the wrong reading is an impossible month, so the widget rejects it and we
//                    move on to the next order (this is why "18/07/2026" was always safe).
//   day === month  - both readings are the same day, so there is nothing to get wrong.
//
// Otherwise there is nothing safe to sweep, and this returns EMPTY rather than a guess. An empty
// list means "ask the widget": the caller probes it with PROBE_DATE (see fillDateField), because
// only the widget knows which order it parses, and a first cut of this fix that answered "just
// write ISO" here silently stopped filling ~40% of dates on the commonest ATS shape there is - an
// unmasked US month-first picker, which had been filling them correctly all along.
export function dateOrderCandidates(el: Element | null | undefined, parts: DateParts): DateOrder[] {
  const detected = detectDateOrder(el);
  if (detected) return [detected];
  const slashIsSelfVerifying = parts.day > 12 || parts.day === parts.month;
  return slashIsSelfVerifying ? ['mdy', 'dmy', 'ymd'] : [];
}

// A date only ONE slash order can parse, used to ask an unmasked widget which order it wants.
//
//   formatDate(PROBE_DATE, 'dmy') === "13/01/2026"  day-first: 13 Jan. month-first: month 13, dead.
//   formatDate(PROBE_DATE, 'mdy') === "01/13/2026"  month-first: 13 Jan. day-first: month 13, dead.
//
// So exactly one surviving a write identifies the order outright, with no guessing. Both surviving
// means the control validates nothing and has told us nothing.
export const PROBE_DATE: DateParts = { year: 2026, month: 1, day: 13 };

// Is this control a date field at all? Used to route a date-shaped answer through the formatter
// instead of the plain text filler.
const DATE_LABEL_RE = /date of birth|birth\s*date|\bdob\b|start date|starting date|earliest.*start|available from|availability date|\bdd\s*[/.-]\s*mm\b|\bmm\s*[/.-]\s*dd\b/i;

export function isDateControl(el: Element | null | undefined, label: string): boolean {
  const input = el as HTMLInputElement | null;
  if (input?.type === 'date') return true;
  if (DATE_LABEL_RE.test(label)) return true;
  const placeholder = input?.getAttribute?.('placeholder') ?? '';
  return detectDateOrder(el) !== null && /\d|[dmy]/i.test(placeholder);
}
