import { describe, expect, it } from 'vitest';
import {
  pageShowsSubmissionConfirmation,
  resumeGenerationProgress,
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
});
