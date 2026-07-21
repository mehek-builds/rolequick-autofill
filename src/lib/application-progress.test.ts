import { describe, expect, it } from 'vitest';
import {
  classifySubmissionOutcome,
  escapeApplicationText,
  pageShowsSubmissionConfirmation,
  pageSubmissionFailureMessage,
  resumeGenerationProgress,
  resumeGenerationStatus,
  SUBMISSION_MONITOR_TIMEOUT_MS,
  submissionProgress,
} from './application-progress';

describe('application progress copy', () => {
  it('moves through concrete resume-generation phases and always shows elapsed time', () => {
    expect(resumeGenerationProgress(0)).toBe('Reading the role · 0s');
    expect(resumeGenerationProgress(7)).toBe('Matching your strongest experience · 7s');
    expect(resumeGenerationProgress(15)).toBe('Tailoring the resume · 15s');
    expect(resumeGenerationProgress(24)).toBe('Checking layout and accuracy · 24s');
  });

  it('turns an extended submission wait into an explicit unknown state', () => {
    expect(submissionProgress(8)).toContain('Waiting for the company portal');
    expect(submissionProgress(20)).toContain('Keep this tab open');
    expect(submissionProgress(46)).toContain('Do not submit again');
  });

  it('recognizes common ATS confirmation language without matching a generic form', () => {
    expect(pageShowsSubmissionConfirmation('Thank you for applying. We received your application.')).toBe(true);
    expect(pageShowsSubmissionConfirmation("We've received your application for Software Engineer.")).toBe(true);
    expect(pageShowsSubmissionConfirmation('Apply for this job First Name Last Name')).toBe(false);
  });

  it('surfaces a portal rejection instead of leaving the task in a waiting state', () => {
    expect(pageSubmissionFailureMessage(
      "We couldn't submit your application. Your application submission was flagged as possible spam.",
    )).toContain('possible spam');
    expect(pageSubmissionFailureMessage('Apply for this job First Name Last Name')).toBeNull();
  });

  it('keeps a capacity retry visible until generation resolves', () => {
    expect(resumeGenerationStatus(24, 'The AI is busy. Retrying attempt 2.')).toBe(
      'The AI is busy. Retrying attempt 2.',
    );
    expect(resumeGenerationStatus(24, null)).toBe('Checking layout and accuracy · 24s');
  });

  it('escapes portal-controlled job metadata before card rendering', () => {
    expect(escapeApplicationText('<img src=x onerror="alert(1)"> & test')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; test',
    );
  });

  it('gives a portal rejection precedence over generic confirmation text', () => {
    expect(classifySubmissionOutcome(
      "Application submitted. We couldn't submit your application because it was possible spam.",
    )).toEqual({
      kind: 'failure',
      message: 'The company portal rejected this submission as possible spam. Review the form before trying again.',
    });
    expect(classifySubmissionOutcome('Thank you for applying.')).toEqual({ kind: 'confirmed' });
    expect(classifySubmissionOutcome('Application form')).toBeNull();
  });

  it('bounds active portal monitoring to one minute', () => {
    expect(SUBMISSION_MONITOR_TIMEOUT_MS).toBe(60_000);
  });
});
