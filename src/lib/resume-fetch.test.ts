import { describe, it, expect } from 'vitest';
import { fetchResumeBlob, resumeFetchSkipReason } from './resume-fetch';
import { selectNeedsYouReasons, skippedReasonsNeedReview } from './autosubmit-gate';

// R-041: when the resume download fails mid-fill, the failure must surface - not vanish into a
// bare catch that leaves the card clean and lets a resume-less application auto-submit (Eight
// Sleep AI/ML, 2026-07-18). These tests pin both halves: fetchResumeBlob turns every non-usable
// outcome into null, and the reason content.ts pushes for that null rides R-010's rails through
// the auto-submit gate.

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"

const pdfResponse = () =>
  new Response(PDF_BYTES, { status: 200, headers: { 'Content-Type': 'application/pdf' } });

describe('fetchResumeBlob', () => {
  it('returns the blob on a healthy download (the success path must stay unchanged)', async () => {
    const blob = await fetchResumeBlob('https://api.example/resume/download/abc', async () => pdfResponse());
    expect(blob).not.toBeNull();
    expect(blob!.size).toBe(PDF_BYTES.length);
    expect(blob!.type).toContain('application/pdf');
  });

  it('returns null on an HTTP error status (the R-040 404, an expired token 403)', async () => {
    // Without the ok check, the error page body would be handed to the file input as if it
    // were the PDF.
    for (const status of [403, 404, 500]) {
      const blob = await fetchResumeBlob('https://api.example/resume/download/abc', async () =>
        new Response('not found', { status }),
      );
      expect(blob).toBeNull();
    }
  });

  it('returns null on a network throw', async () => {
    const blob = await fetchResumeBlob('https://api.example/resume/download/abc', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(blob).toBeNull();
  });

  it('returns null on a 200 with an empty body', async () => {
    const blob = await fetchResumeBlob('https://api.example/resume/download/abc', async () =>
      new Response(new Uint8Array(0), { status: 200, headers: { 'Content-Type': 'application/pdf' } }),
    );
    expect(blob).toBeNull();
  });

  it('returns null on a 200 whose body is an HTML page (SPA fallback, not a PDF)', async () => {
    const blob = await fetchResumeBlob('https://api.example/resume/download/abc', async () =>
      new Response('<!doctype html><title>Not found</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    );
    expect(blob).toBeNull();
  });
});

describe('resumeFetchSkipReason through the card and the gate (the R-041 pipeline)', () => {
  it('a failed download ends with the reason on the card and auto-submit held', async () => {
    // The pipeline content.ts runs, in pure form: fetch fails -> null -> the reason joins the
    // adapter's skipped_reasons -> the card lists it under "Still needs you" -> the gate holds.
    const blob = await fetchResumeBlob('https://api.example/resume/download/abc', async () =>
      new Response('gone', { status: 404 }),
    );
    expect(blob).toBeNull();

    const skipped_reasons = ['resume: no generated resume file available']; // what the adapter saw
    if (!blob) skipped_reasons.push(resumeFetchSkipReason);

    expect(selectNeedsYouReasons(skipped_reasons)).toContain('resume could not be attached - attach it yourself');
    expect(skippedReasonsNeedReview(skipped_reasons)).toBe(true); // auto-submit held
  });

  it('a healthy download adds no reason and does not hold auto-submit', async () => {
    const blob = await fetchResumeBlob('https://api.example/resume/download/abc', async () => pdfResponse());
    const skipped_reasons: string[] = [];
    if (!blob) skipped_reasons.push(resumeFetchSkipReason);

    expect(skipped_reasons).toEqual([]);
    expect(skippedReasonsNeedReview(skipped_reasons)).toBe(false);
  });
});
