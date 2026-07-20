// Downloading the generated resume so the adapter can attach it (R-041, extension half).
//
// The backend half is R-040 (fresh resumes no longer 404 on download). This module is for when
// the download DOES fail anyway - a retention-swept resume, an expired token, a network drop, or
// a 200 whose body is not a PDF at all (an SPA error page, an empty stream). content.ts used to
// swallow every one of these in a bare catch: the adapter just saw "no blob", the card reported a
// successful fill, and the student could submit resume-less without ever being told (Eight Sleep
// AI/ML, 2026-07-18). A missing resume on a real submission is the worst silent failure this
// extension can produce, so the failure is now a first-class fill outcome.
//
// Lives in lib/ rather than inline in content.ts for the same reason autosubmit-gate.ts does: the
// decision (what counts as a usable resume file) is pure and has a real failure mode, and
// content.ts cannot be imported by a test (it pulls in defineContentScript at module load).

// The ready-to-push skip reason for a failed download, mirroring R-010's document flag: pushed
// into skipped_reasons after the fill, shown on the card's "Still needs you" list, and matched by
// the auto-submit gate so the countdown never fires over a resume-less application. "could not be
// attached" is load-bearing the same way R-010's "left for" is - REVIEW_FLAG and
// selectNeedsYouReasons (autosubmit-gate.ts) both key on it, and the tripwire tests in
// autosubmit-gate.test.ts fail if either side is reworded without the other.
//
// Deliberately NOT prefixed "resume:" - that prefix marks the adapters' own resume outcomes,
// which the card folds into its one-line warning instead of the "Still needs you" list.
export const resumeFetchSkipReason = 'resume could not be attached - attach it yourself';

// Fetches the generated resume file, returning null on ANY outcome that is not a usable file:
// an HTTP error status, a network throw, an empty body, or an HTML body (a 200 error page from
// an SPA fallback - handing that to the file input would upload garbage labelled as the PDF).
// Callers surface null as resumeFetchSkipReason and keep filling; the rest of the form must
// never be lost to a missing resume.
//
// `fetchFn` is injectable so the failure modes are unit-testable; content.ts passes nothing and
// gets the page's real fetch.
export async function fetchResumeBlob(
  url: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<Blob | null> {
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size === 0) return null;
    if (/text\/html/i.test(blob.type)) return null;
    return blob;
  } catch {
    return null;
  }
}
