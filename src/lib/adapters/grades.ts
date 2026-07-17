import type { ApplicationProfile } from '../types';

// Academic-record questions (R-005). Live QA 2026-07-16 (Abound, Ashby): a REQUIRED "What is your
// current grade average? (as a percentage, e.g. 68%)" and "What degree classification are you
// predicted..." were unfillable, because nothing in the stack - ParsedProfile, /profile, any
// adapter - had ever handled a GPA. GPA is among the most common REQUIRED intern fields, and
// students are the whole market.
//
// ── The decision, and why this file is shaped the way it is ──────────────────
// Mehek's call (2026-07-16): store the GPA with its scale AND convert to a form's scale via a
// DISCLOSED mapping, with the converted value flagged for review before submit.
//
// That decision runs against the issue register's own warning ("a US 4.0 GPA does NOT convert
// cleanly to a UK percentage/classification ... store the GPA + scale, not fabricate a
// conversion") and against R-004, which was rated CRITICAL for precisely this shape of error:
// deriving a claim from adjacent profile data and shipping it to a real employer as fact. She
// chose conversion knowingly, and the flag-before-submit is what makes it defensible.
//
// So the flag is NOT garnish here, it is the entire safety argument, and this module is built so a
// caller cannot accidentally drop it: a converted answer returns `needsReview: true` alongside a
// `disclosure` string naming the exact mapping applied. A caller that fills the value and ignores
// those is shipping an unreviewed derived claim about someone's academic record.
//
// Two further guards on the conversion itself:
//   1. NEVER linear. 3.89/4.0 is not "97%". The register calls that out by name, and it is the
//      single most tempting wrong answer here.
//   2. NEVER over-claim. Conversions map to a BAND (First / 2:1 / 2:2 / Third), and a percentage
//      field gets that band's FLOOR. 3.89 is a high First, so 70% under-states her - deliberately.
//      Under-claiming costs an interview; over-claiming is a false statement on an application.
//      She can raise it herself; the flag is what puts it in front of her.

export type GradeQuestion =
  | { field: 'major'; value?: string; needsReview: false }
  | { field: 'gpa'; value?: string; needsReview: false }
  | { field: 'gpa'; value: string; needsReview: true; disclosure: string };

// ── Question shapes ──────────────────────────────────────────────────────────
// Every branch below TERMINATES its block in the adapters (fill or flag, then continue), so a
// false positive here does not merely mislabel a field: it swallows the question away from the
// essay drafter and the known-answer path entirely, and on the percent path it FILLS a number.
// That is R-020's lesson replayed (a matcher that fires on a word anywhere in a label is
// default-allow), so each shape requires its word in an ACADEMIC position, not merely present.

// "major" the noun about the student ("your major", "intended major", a bare "Major" label), never
// the adjective: "describe a major project you led" is an essay, and matching it would leave the
// essay undrafted with a bogus "major question left for you" reason holding auto-submit.
const MAJOR_QUESTION = /\b(your|intended|declared|college|university|undergraduate|academic|current|primary|double)\s+majors?\b|^\s*majors?\s*[:*.?]?\s*$|field of study|course of study|area of study|what.{0,10}(are|is) you studying|degree subject|programme of study|program of study/i;
// A GPA question in its own terms ("GPA", "grade point average", "cumulative average").
const GPA_QUESTION = /\bgpa\b|grade.?point.?average|cumulative average|academic average/i;
// A grade question posed on a percentage scale. A percent word ALONE is not one: "willingness to
// travel (percentage)" is a real and common intern-form field, and because the percent path fills
// a converted number, a loose match here would write "70" into a travel question. A mis-fill is
// strictly worse than the non-fill this module exists to cure, so the percent word only counts
// beside a grade word. "grade average" alone also counts: that is the UK phrasing this was built
// for (live on Abound, 2026-07-16), units or no units.
const GRADE_AVERAGE = /grade average/i;
const PERCENT_WORD = /percentage|\bpercent\b|out of 100|%\)/i;
const GRADE_WORD = /\bgrades?\b|\baverage\b|\bgpa\b|\bmarks?\b|academic|classification/i;
// A UK degree-classification question. Each alternative anchors the give-away word to a degree
// context, because the words travel: bare "classification" is a job-classification field on
// government forms, bare "honours" is the honours-and-awards section, and a bare "2.1" is a
// numbered section heading ("2.1 Tell us why...").
const CLASSIFICATION_QUESTION = /(degree|honours|hons|expected|predicted|anticipated|university) classification|classification (of your degree|are you|do you)|predicted (degree|classification|grade|class)\b|(first|second|third).class (honours|degree)|\b2:[12]\b/i;

// US 4.0 -> UK degree classification. Bands, not a formula, because there IS no formula: the two
// systems measure different things, and every credible mapping (WES and university admissions
// tables) is banded for that reason. Floors are the conventional UK boundaries: First 70%, 2:1 60%,
// 2:2 50%, Third 40%.
const UK_BANDS: Array<{ min: number; name: string; floorPct: number }> = [
  { min: 3.7, name: 'First Class Honours', floorPct: 70 },
  { min: 3.3, name: 'Upper Second Class Honours (2:1)', floorPct: 60 },
  { min: 2.7, name: 'Lower Second Class Honours (2:2)', floorPct: 50 },
  { min: 2.0, name: 'Third Class Honours', floorPct: 40 },
];

function ukBand(gpa: number): { name: string; floorPct: number } | null {
  return UK_BANDS.find((b) => gpa >= b.min) ?? null;
}

// Is the stored scale a US-style 4.0? Only that scale has a mapping here; anything else (a 10-point
// CGPA, a 20-point French scale) is left for the student rather than guessed at.
function isFourPointScale(scale: string | undefined): boolean {
  if (!scale) return false;
  return /^4(\.0+)?$/.test(scale.trim());
}

export function gradeQuestion(label: string, ap: ApplicationProfile): GradeQuestion | null {
  if (MAJOR_QUESTION.test(label)) return { field: 'major', value: ap.major, needsReview: false };

  const asksPercent = GRADE_AVERAGE.test(label) || (PERCENT_WORD.test(label) && GRADE_WORD.test(label));
  const asksClassification = CLASSIFICATION_QUESTION.test(label);
  const asksGpa = GPA_QUESTION.test(label);
  if (!asksGpa && !asksPercent && !asksClassification) return null;

  const gpa = ap.gpa?.trim();
  // Classify the question even with nothing stored, so the caller flags it rather than letting it
  // fall through to be silently left blank. Same contract as linkQuestion / locationQuestion.
  if (!gpa) return { field: 'gpa', value: undefined, needsReview: false };

  // A GPA question on our own terms: fill it verbatim. This is her real number, so no review flag.
  // Checked BEFORE the conversion branches: "cumulative GPA (out of 4.0)" mentions a scale but is
  // still just asking for the GPA.
  if (asksGpa && !asksPercent && !asksClassification) {
    return { field: 'gpa', value: gpa, needsReview: false };
  }

  // From here the form wants a scale we do not store. Convert only from a 4.0 scale, only into a
  // band, and only with a disclosure + review flag attached.
  const numeric = Number(gpa);
  if (!Number.isFinite(numeric) || !isFourPointScale(ap.gpa_scale)) {
    return { field: 'gpa', value: undefined, needsReview: false };
  }
  const band = ukBand(numeric);
  if (!band) return { field: 'gpa', value: undefined, needsReview: false };

  if (asksClassification) {
    return {
      field: 'gpa',
      value: band.name,
      needsReview: true,
      disclosure: `converted from GPA ${gpa}/${ap.gpa_scale} to "${band.name}" using the standard US-to-UK band mapping`,
    };
  }
  // Percentage: the band FLOOR, never a linear scaling. 3.89/4.0 renders as 70%, not 97%.
  return {
    field: 'gpa',
    value: String(band.floorPct),
    needsReview: true,
    disclosure: `converted from GPA ${gpa}/${ap.gpa_scale} to ${band.floorPct}% (the floor of the ${band.name} band; not a direct percentage of your GPA)`,
  };
}

// "review before submitting" is what the auto-submit gate's REVIEW_FLAG matches, so a converted
// grade HOLDS the countdown. That is the whole safety argument for converting at all: the student
// sees the derived number before it reaches an employer.
export function gradeReviewReason(label: string, disclosure: string): string {
  return `grade answer ${disclosure} - review before submitting: "${label.slice(0, 60)}"`;
}

// A grade question we could not answer at all, left for the student. "left for" holds auto-submit.
export function gradeSkipReason(field: 'gpa' | 'major', label: string): string {
  return `${field === 'major' ? 'major' : 'grade'} question left for you (not in your profile): "${label.slice(0, 60)}"`;
}
