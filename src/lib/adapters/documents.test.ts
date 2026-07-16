import { describe, it, expect } from 'vitest';
import { documentSlotReason } from './shared/dom';
import { skippedReasonsNeedReview } from '../autosubmit-gate';

// R-010 (live QA 2026-07-16, Global Relay co-op): the form said "In order to be considered for this
// role, you must include post-secondary transcripts" and rendered a second Attach input beyond the
// resume. RoleQuick left it "(no file)" and said NOTHING - the card reported a successful fill, and
// the student met the empty required upload at submit. RoleQuick can only ever produce a resume, so
// the fix is not to attach the transcript; it is to SAY that it cannot.
//
// The guards carry most of the weight here. A false positive fires on every form and trains the
// student to ignore the warning, which is worse than never warning at all.

describe('documentSlotReason: flags what RoleQuick cannot attach', () => {
  it('flags a required transcript (the live Global Relay shape)', () => {
    const reason = documentSlotReason('post-secondary transcripts', true);
    expect(reason).toContain('transcript');
  });

  it('flags a document named in its label even when not marked required', () => {
    // Global Relay stated the demand in prose; the input need not carry a `required` attribute.
    expect(documentSlotReason('transcripts', false)).not.toBeNull();
    expect(documentSlotReason('cover letter', false)).not.toBeNull();
    expect(documentSlotReason('writing sample', false)).not.toBeNull();
    expect(documentSlotReason('letter of recommendation', false)).not.toBeNull();
  });

  it('names the document, so the student knows what to go find', () => {
    expect(documentSlotReason('upload your cover letter here', false)).toContain('cover letter');
    expect(documentSlotReason('academic transcript', false)).toContain('transcript');
  });

  it('holds auto-submit, so the student is told before the form can fire', () => {
    // Built from the real builder rather than hand-typed: reword it out of REVIEW_FLAG and this
    // fails HERE, instead of letting a form auto-submit with a required document missing.
    const reason = documentSlotReason('transcripts', true)!;
    expect(skippedReasonsNeedReview([reason])).toBe(true);
  });
});

describe('documentSlotReason: what must NOT be flagged', () => {
  it("does NOT flag Ashby's own resume-parser widget", () => {
    // ashby.ts's header documents this trap: the parser widget is a SECOND input[type=file], first
    // in DOM order. Flagging it would fire a false "needs a document I don't have" on EVERY Ashby
    // form, which is exactly how a warning stops being read.
    expect(documentSlotReason('autofill with resume', true)).toBeNull();
    expect(documentSlotReason('upload your resume to autofill this application', true)).toBeNull();
    expect(documentSlotReason('parse my resume', true)).toBeNull();
  });

  it('does NOT double-report the resume slot the adapter already reports', () => {
    // Each adapter emits its own "resume: ..." reason. Saying it twice in different words reads as
    // two separate problems.
    expect(documentSlotReason('resume', true)).toBeNull();
    expect(documentSlotReason('resume/cv', true)).toBeNull();
    expect(documentSlotReason('résumé', true)).toBeNull();
    expect(documentSlotReason('cv', true)).toBeNull();
  });

  it('stays quiet on an unremarkable optional file input', () => {
    // No positive signal: not required, and the label names no document we know we cannot make.
    // Silence here is what keeps the warning meaningful on the form where it matters.
    expect(documentSlotReason('attach something', false)).toBeNull();
    expect(documentSlotReason('', false)).toBeNull();
  });

  it('falls back to a generic wording for a required upload it cannot name', () => {
    // Required but unnamed: still worth surfacing (it will block submission), just without
    // inventing a document type.
    expect(documentSlotReason('attach', true)).toContain('a document');
  });
});
