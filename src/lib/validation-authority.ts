// E-015: a [required]/asterisk sweep cannot enumerate a form's required fields - Ashby renders
// required entries below the fold without the attributes the sweep keys on (Notion GRC: six
// "Missing entry" refusals on fields no sweep had seen), and Greenhouse marks a required transcript
// upload only in its post-submit error markup (Five Rings, 2026-07-18). The form's OWN validation
// list is the only authoritative enumeration, so after a refused submit we read the form's error
// nodes and promote each one into a skipped_reason. The card then shows the authority's list, not
// our heuristic's.
//
// Pure DOM-in, strings-out: no listeners, no timers, no card knowledge. content.ts owns when to
// call this (after a submit click settles) and what to do with the reasons (merge + re-render).
// Selector provenance matters here - each block cites the live capture it was written against,
// because these are other people's DOMs and they change without notice.

export type ValidationError = {
  label: string;
  source: 'greenhouse-label' | 'greenhouse-helper' | 'ashby-missing-entry';
};

const label = (t: string | null | undefined): string =>
  (t || '')
    .replace(/\s+/g, ' ')
    .replace(/\*+\s*$/, '')
    .trim();

// The generic ".error"-substring net catches Ashby's per-field messages but also matches
// containers that WRAP many fields (a form-level "needs corrections" banner wraps everything).
// Anything longer than a label plus a short sentence is a container, not a field error.
const MAX_ERROR_TEXT = 180;

export function extractValidationErrors(root: ParentNode): ValidationError[] {
  const out: ValidationError[] = [];
  const seen = new Set<string>();
  const push = (raw: string | null | undefined, source: ValidationError['source']) => {
    const l = label(raw);
    if (!l || l.length > 160) return;
    const key = l.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label: l, source });
  };

  // Greenhouse, new React form. Fixture: Five Rings refused submit (2026-07-18 live capture).
  // Field labels carry an --error modifier directly:
  //   <div class="label upload-label upload-label--error">Please upload your most recent transcript...</div>
  //   <label class="label select__label select__label--error" for="question_N">Please indicate your overall GPA.*</label>
  for (const el of root.querySelectorAll(
    '[class*="upload-label--error"], [class*="select__label--error"], label[class*="label--error"]',
  )) {
    push(el.textContent, 'greenhouse-label');
  }
  // Greenhouse helper texts say only "This field is required." - the field's name lives on the
  // sibling label wired by id convention: question_N-error <-> question_N-label / upload-label-question_N.
  for (const el of root.querySelectorAll('[class*="helper-text--error"][id$="-error"]')) {
    const q = el.id.slice(0, -'-error'.length);
    const named =
      (root as Element | Document).querySelector?.(`#${cssEscape(q)}-label`) ||
      (root as Element | Document).querySelector?.(`#upload-label-${cssEscape(q)}`) ||
      (root as Element | Document).querySelector?.(`label[for="${cssEscape(q)}"]`);
    if (named) push(named.textContent, 'greenhouse-helper');
  }

  // Ashby: refusal renders per-field "Missing entry for required field" messages (E-015's origin,
  // Notion GRC 2026-07-17). The message node sits inside the field entry whose label names the
  // field; when the message itself carries the field name after a colon, prefer that.
  for (const el of root.querySelectorAll('[class*="error" i], [role="alert"]')) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length > MAX_ERROR_TEXT) continue;
    const m = /missing entry for required field[:\s]*(.*)$/i.exec(t);
    if (!m) continue;
    const named = m[1] ? m[1] : nearestFieldEntryLabel(el);
    push(named, 'ashby-missing-entry');
  }

  return out;
}

function nearestFieldEntryLabel(el: Element): string {
  const entry = el.closest('.ashby-application-form-field-entry, [class*="_fieldEntry_"]');
  return label(entry?.querySelector('label, legend')?.textContent);
}

// jsdom (vitest) lacks CSS.escape; ids here are question_NNN shaped, so a conservative manual
// escape of anything outside [-\w] keeps both environments honest.
function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^-\w]/g, (c) => `\\${c}`);
}

// Phrased so the existing pure gates recognize them without modification: REVIEW_FLAG (the
// auto-submit hold) matches on "left blank", selectNeedsYouReasons' filter and its required-first
// sort match on "required". "form validation" marks provenance so a log reader can tell heuristic
// finds from authority finds.
export function validationErrorsToReasons(errors: ValidationError[]): string[] {
  return errors.map((e) => `required (form validation): "${e.label}" left blank at submit`);
}

// Validation reasons name fields the heuristic sweep may ALSO have flagged ("required open-ended
// question left blank: X" + validation's X). Containment on the normalized field name dedupes
// them; validation entries win nothing by appearing twice.
export function mergeValidationReasons(existing: string[], validation: string[]): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const kept = validation.filter((v) => {
    const q = norm(v.replace(/^required \(form validation\): /i, ''));
    const core = q.replace(/ left blank at submit$/, '');
    return !existing.some((e) => norm(e).includes(core.slice(0, 60)));
  });
  return [...existing, ...kept];
}
