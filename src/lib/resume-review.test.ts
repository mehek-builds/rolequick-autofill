import { describe, expect, it } from 'vitest';
import { buildResumeReviewMessage } from './resume-review';

describe('resume review message', () => {
  it('shows one-page omissions before the student approves attachment', () => {
    const message = buildResumeReviewMessage({
      ready_to_attach: true,
      issues: [],
      warnings: [],
      ats_keyword_coverage_pct: 22,
      trimmed_for_one_page_fit: true,
      sparse_add_more_experience: false,
      grounding_removed: [],
      omissions: ['Removed lower-fit project entry: Old Project'],
    });
    expect(message).toContain('Before it is attached');
    expect(message).toContain('Old Project');
    expect(message).toContain('Select Cancel to leave the form unchanged');
  });

  it('reports grounding removals separately from normal one-page selection', () => {
    const message = buildResumeReviewMessage({
      ready_to_attach: true,
      issues: [],
      warnings: [],
      ats_keyword_coverage_pct: 30,
      trimmed_for_one_page_fit: false,
      sparse_add_more_experience: false,
      grounding_removed: ['dropped ungrounded skill'],
      omissions: [],
    });
    expect(message).toContain('Unsupported generated claims were removed');
  });
});
