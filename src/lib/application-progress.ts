export function resumeGenerationProgress(elapsedSeconds: number): string {
  const elapsed = Math.max(0, Math.floor(elapsedSeconds));
  if (elapsed < 5) return `Reading the role · ${elapsed}s`;
  if (elapsed < 12) return `Matching your strongest experience · ${elapsed}s`;
  if (elapsed < 20) return `Tailoring the resume · ${elapsed}s`;
  return `Checking layout and accuracy · ${elapsed}s`;
}

export function resumeGenerationStatus(elapsedSeconds: number, retryMessage: string | null): string {
  return retryMessage ?? resumeGenerationProgress(elapsedSeconds);
}

export function escapeApplicationText(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] as string,
  );
}

export const SUBMISSION_MONITOR_TIMEOUT_MS = 60_000;

export function submissionProgress(elapsedSeconds: number): string {
  const elapsed = Math.max(0, Math.floor(elapsedSeconds));
  if (elapsed < 15) return `Waiting for the company portal · ${elapsed}s`;
  if (elapsed < 45) return `Still waiting for confirmation · ${elapsed}s. Keep this tab open.`;
  return 'Confirmation has not arrived yet. Do not submit again. Check the portal or your email before retrying.';
}

export function pageShowsSubmissionConfirmation(text: string): boolean {
  return /thank you for applying|application (?:has been )?(?:submitted|received)|we(?:'|’)ve received your application|application complete/i
    .test(text.replace(/\s+/g, ' '));
}

export function pageSubmissionFailureMessage(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ');
  if (/possible spam/i.test(normalized)) {
    return 'The company portal rejected this submission as possible spam. Review the form before trying again.';
  }
  if (/couldn['’]t submit your application|unable to submit (?:your )?application/i.test(normalized)) {
    return 'The company portal rejected the submission. Review its error message before trying again.';
  }
  return null;
}

export type SubmissionOutcome =
  | { kind: 'failure'; message: string }
  | { kind: 'confirmed' }
  | null;

export function classifySubmissionOutcome(text: string): SubmissionOutcome {
  const failure = pageSubmissionFailureMessage(text);
  if (failure) return { kind: 'failure', message: failure };
  if (pageShowsSubmissionConfirmation(text)) return { kind: 'confirmed' };
  return null;
}
