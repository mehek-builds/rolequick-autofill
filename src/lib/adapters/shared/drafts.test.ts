import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DRAFT_CONCURRENCY, isDraftTargetAvailable, runDraftQueue } from './drafts';

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

  it('streams out-of-order results without exceeding the worker limit', async () => {
    const resolvers = new Map<number, (answer: string) => void>();
    const started: number[] = [];
    const settled: number[] = [];
    let active = 0;
    let maxActive = 0;

    const run = runDraftQueue({
      items: [1, 2, 3, 4],
      promptFor: String,
      draftAnswer: (question) => {
        const item = Number(question);
        started.push(item);
        active++;
        maxActive = Math.max(maxActive, active);
        return new Promise<string>((resolve) => {
          resolvers.set(item, (answer) => {
            active--;
            resolve(answer);
          });
        });
      },
      onSettled: async (item) => {
        await Promise.resolve();
        settled.push(item);
      },
    });

    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    resolvers.get(2)?.('second finished first');
    await vi.waitFor(() => expect(settled).toEqual([2]));
    expect(started).toEqual([1, 2, 3, 4]);
    expect(maxActive).toBe(DEFAULT_DRAFT_CONCURRENCY);

    resolvers.get(1)?.('first');
    resolvers.get(3)?.('third');
    resolvers.get(4)?.('fourth');
    await run;

    expect(settled).toEqual([2, 1, 3, 4]);
  });

  it('does no work for an empty queue', async () => {
    const draftAnswer = vi.fn(async () => 'answer');
    const promptFor = vi.fn(String);
    const onSettled = vi.fn();
    const onProgress = vi.fn();

    await runDraftQueue({
      items: [],
      draftAnswer,
      promptFor,
      onSettled,
      onProgress,
    });

    expect(draftAnswer).not.toHaveBeenCalled();
    expect(promptFor).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('waits for sibling workers before propagating a settlement failure', async () => {
    let finishSecond!: () => void;
    const secondSettled = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const completed: number[] = [];

    const run = runDraftQueue({
      items: [1, 2],
      promptFor: String,
      draftAnswer: async (question) => question,
      onSettled: async (item) => {
        if (item === 1) throw new Error('DOM write failed');
        await secondSettled;
        completed.push(item);
      },
    });
    const rejection = expect(run).rejects.toThrow('DOM write failed');
    await Promise.resolve();

    expect(completed).toEqual([]);
    finishSecond();
    await rejection;
    expect(completed).toEqual([2]);
  });

  it('does not settle drafts after cancellation', async () => {
    const controller = new AbortController();
    let finishDraft!: (answer: string) => void;
    const draft = new Promise<string>((resolve) => {
      finishDraft = resolve;
    });
    const onSettled = vi.fn();

    const run = runDraftQueue({
      items: [1],
      signal: controller.signal,
      promptFor: String,
      draftAnswer: () => draft,
      onSettled,
    });
    await Promise.resolve();

    controller.abort();
    finishDraft('late answer');
    await run;

    expect(onSettled).not.toHaveBeenCalled();
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

describe('isDraftTargetAvailable', () => {
  it('only accepts a connected target the student has not answered', () => {
    expect(isDraftTargetAvailable({ isConnected: true, value: '' })).toBe(true);
    expect(isDraftTargetAvailable({ isConnected: true, value: 'student answer' })).toBe(false);
    expect(isDraftTargetAvailable({ isConnected: false, value: '' })).toBe(false);
  });
});
