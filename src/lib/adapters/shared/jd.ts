// Job-description sanity checking (R-013, found live 2026-07-17 across every Ashby board tested).
//
// The bug this exists to close: `extractAshbyJdText` fell back to `document.body.innerText` with no
// length floor and no "does this look like a JD?" check, so a total extraction failure was
// indistinguishable from success and flowed straight into resume tailoring. On the Ashby
// Application tab the body is just the form, so 7 of 9-11 real applications submitted on
// 2026-07-16/17 were tailored to a job TITLE and some form labels, having never read the job
// description. The student gets a plausible-looking "tailored" resume that was never tailored.
//
// The quiet failure is the dangerous one. Enpal at least failed loudly (a 5-char "JD" scored 10%
// coverage and errored); Cohere and Mistral SUCCEEDED while never having read the JD, because the
// job title alone carried enough keywords to clear the 18% bar. So the check below is not about
// quality scoring - it is about telling "I read the job description" apart from "I read the form".

// Ashby's own widget text. A real job description never says "Autofill from resume" - that is the
// resume-parser widget sitting next to the file input, and its presence means we scraped the form
// rather than the posting. The register's suggested regression test names these exactly.
const FORM_CHROME_MARKERS = [
  /autofill from resume/i,
  /drag and drop/i,
  /upload file/i,
  /attach.{0,12}(resume|cv)/i,
];

// A JD that clears this is short even for a terse posting; the real ones measured on live boards
// ran 979 to 11,063 chars. The failures ran 5 chars (Enpal's header) and ~1,261 (Cohere's form
// chrome) - and the 1,261 is why length alone is not enough and the chrome markers carry the call.
export const MIN_JD_CHARS = 400;

export function looksLikeJobDescription(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  if (t.length < MIN_JD_CHARS) return false;
  return !FORM_CHROME_MARKERS.some((re) => re.test(t));
}

// Strip an HTML description down to the plain text the tailoring prompt wants. Used for sources
// that hand back markup rather than text (Ashby's embedded posting payload).
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(p|div|li|br|h[1-6]|tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n') // a closing tag leaves a space that would sit before the break
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Thrown/returned when no source produced something that reads like a job description. The caller
// surfaces this DISTINCTLY from a resume-generation failure: tailoring to junk is the thing R-013
// is about, and "we couldn't read the posting" is a different problem with a different remedy than
// "the model failed" - which the student would otherwise retry forever (see R-012's identical
// complaint about an error message that hides its cause).
export const JD_UNREADABLE = 'JD_UNREADABLE';
