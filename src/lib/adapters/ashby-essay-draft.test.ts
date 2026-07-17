// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { fillAshbyApplication } from './ashby';
import { unreadableQuestionSkipReason } from './generic';
import { skippedReasonsNeedReview } from '../autosubmit-gate';
import type { ApplicationProfile, Profile } from '../types';

// The R-006 rework (firstNonEmptyText + isDraftableQuestion) is guarded at the unit level in
// generic.answers.test.ts, but both of those are pure helpers, and R-006's actual failure lived in
// the space BETWEEN them: the adapter loop that reads a label, decides which branch owns the block,
// and only then hands a question to the drafter. That loop has since grown R-020's phone matching,
// R-028's placement rules, and the shared link classifier, any of which could intercept an essay
// block before it ever reaches the guard. So this file runs the real fillAshbyApplication against
// Ashby-shaped markup, in jsdom (same one-file exception fill-date-field.test.ts already carved
// out: the rest of the adapter suite stays DOM-free, but a loop's routing cannot be proven without
// the DOM it routes on).
//
// The three cases are the three directions R-006 can regress in, and the first is the one the
// original fix never worried about: a guard added to stop drafting-nothing must not stop drafting
// SOMETHING. This repo has already paid for that lesson twice (R-020's fix became R-028's mis-fill,
// and the reverted R-030 guard traded a mis-fill for a non-fill), so the happy path gets pinned
// here before the sad paths do.

const ap = (o: Partial<ApplicationProfile> = {}): ApplicationProfile => o as ApplicationProfile;

// Minimal Ashby question entry, per the adapter's own selectors (verified live 2026-07-04:
// `fieldset[class*="_fieldEntry_"]` is the per-question container, innermost match only).
function fieldEntry(inner: string): void {
  const fieldset = document.createElement('fieldset');
  fieldset.className = '_fieldEntry_x1y2z';
  fieldset.innerHTML = inner;
  document.body.appendChild(fieldset);
}

// Collects every question the drafter is asked, so a test can assert not just THAT it was called
// but with WHAT: R-029 is the drafter running with a wrong premise, so the exact question string
// reaching it is part of the contract, not an implementation detail.
function recordingDrafter(draft = 'Because I have shipped things.') {
  const questions: string[] = [];
  const draftAnswer = async (question: string) => {
    questions.push(question);
    return draft;
  };
  return { questions, draftAnswer };
}

function runFill(draftAnswer: (question: string) => Promise<string | null>) {
  return fillAshbyApplication({
    // Empty identity values on purpose: no _systemfield_ inputs exist in these fixtures, and the
    // test is about the question loop, not the identity fields.
    fullName: '',
    profile: {} as Profile,
    applicationProfile: ap(),
    draftAnswer,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('fillAshbyApplication essay drafting (R-006, both directions)', () => {
  it('still drafts a normal labelled essay: the guard must not turn into a non-fill', async () => {
    // The exact shape that drafted fine on 0.3.6 ("Why Cohere?" live, 2026-07-16). If the guard,
    // the label rework, or anything main grew since intercepts this block, R-006's fix has become
    // its own R-020 and this fails.
    fieldEntry('<label>Why Cohere?</label><textarea></textarea>');
    const { questions, draftAnswer } = recordingDrafter();

    const result = await runFill(draftAnswer);

    expect(questions).toEqual(['why cohere?']);
    expect(document.querySelector('textarea')!.value).toBe('Because I have shipped things.');
    expect(result.ai_drafted).toBe(1);
    // A drafted essay is reviewable, not submittable: the AI-drafted banner must still hold the
    // auto-submit gate exactly as it did before this fix.
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  });

  it('reads through an existing-but-empty legend and drafts the REAL question (the live R-006 DOM)', async () => {
    // "Why Abound?": a <legend> that exists but renders blank, with the question in the <label>
    // beneath it. 0.3.6 resolved this whole block to "" and the drafter got a guaranteed 400. The
    // assertion is exact on purpose: the drafter must receive the label's text, not "" and not the
    // container's glued-together fallback text, because a mangled question is R-029 fuel.
    fieldEntry('<legend></legend><label>Why Abound?</label><textarea></textarea>');
    const { questions, draftAnswer } = recordingDrafter();

    const result = await runFill(draftAnswer);

    expect(questions).toEqual(['why abound?']);
    expect(document.querySelector('textarea')!.value).toBe('Because I have shipped things.');
    expect(result.ai_drafted).toBe(1);
  });

  it('never hands an unreadable question to the drafter, and says so on the card', async () => {
    // No legend text, no label, no container text at all: nothing firstNonEmptyText can recover.
    // The drafter must not be called (the backend rejects question: "" outright, and the metered
    // call would buy nothing), the card must carry the shared reason, and that reason must HOLD
    // auto-submit, because the alternative is a required essay auto-submitting blank.
    fieldEntry('<textarea></textarea>');
    const { questions, draftAnswer } = recordingDrafter();

    const result = await runFill(draftAnswer);

    expect(questions).toEqual([]);
    expect(result.ai_drafted).toBe(0);
    expect(document.querySelector('textarea')!.value).toBe('');
    expect(result.skipped_reasons).toContain(unreadableQuestionSkipReason());
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  });
});
