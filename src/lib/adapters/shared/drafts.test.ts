import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DRAFT_CONCURRENCY, runDraftQueue } from './drafts';

describe('runDraftQueue', () => {
  it('bounds concurrent draft requests while processing every item', async () => {
    let releaseRequests!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const started: number[] = [];
    const settled: Array<{ item: number; draft: string | null }> = [];

    const run = runDraftQueue({
      items: [1, 2, 3, 4, 5],
      promptFor: (item) => `question ${item}`,
      draftAnswer: async (question) => {
        const item = Number(question.split(' ')[1]);
        started.push(item);
        active++;
        maxActive = Math.max(maxActive, active);
        await requestGate;
        active--;
        return ` answer ${item} `;
      },
      onSettled: (item, draft) => {
        settled.push({ item, draft });
      },
    });

    await vi.waitFor(() => expect(started).toHaveLength(DEFAULT_DRAFT_CONCURRENCY));
    expect(maxActive).toBe(DEFAULT_DRAFT_CONCURRENCY);

    releaseRequests();
    await run;

    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(settled).toEqual([
      { item: 1, draft: 'answer 1' },
      { item: 2, draft: 'answer 2' },
      { item: 3, draft: 'answer 3' },
      { item: 4, draft: 'answer 4' },
      { item: 5, draft: 'answer 5' },
    ]);
  });

  it('normalizes empty and failed responses to null and reports monotonic progress', async () => {
    const progress: number[] = [];
    const settled: Array<string | null> = [];

    await runDraftQueue({
      items: ['good', 'empty', 'failed'],
      concurrency: 1,
      promptFor: (item) => item,
      draftAnswer: async (question) => {
        if (question === 'failed') throw new Error('backend unavailable');
        return question === 'empty' ? '   ' : '  usable answer  ';
      },
      onSettled: (_item, draft) => {
        settled.push(draft);
      },
      onProgress: (pending) => progress.push(pending),
    });

    expect(settled).toEqual(['usable answer', null, null]);
    expect(progress).toEqual([3, 2, 1, 0]);
  });

  it.each([
    { concurrency: 0, expected: 1 },
    { concurrency: Number.NaN, expected: DEFAULT_DRAFT_CONCURRENCY },
  ])('normalizes a concurrency of $concurrency', async ({ concurrency, expected }) => {
    let releaseRequests!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    const run = runDraftQueue({
      items: [1, 2, 3],
      concurrency,
      promptFor: String,
      draftAnswer: async (question) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await requestGate;
        active--;
        return question;
      },
      onSettled: (item) => {
        order.push(item);
      },
    });

    await vi.waitFor(() => expect(maxActive).toBe(expected));
    releaseRequests();
    await run;

    expect(order).toEqual([1, 2, 3]);
  });
});
