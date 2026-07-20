import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDraftQueue } from './adapters/shared/drafts';
import { withInactivityTimeout } from './inactivity-timeout';

describe('withInactivityTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects an operation that stops making progress', async () => {
    vi.useFakeTimers();
    let operationSignal!: AbortSignal;
    const run = withInactivityTimeout((_heartbeat, signal) => {
      operationSignal = signal;
      return new Promise<string>(() => {});
    }, 100);
    const rejection = expect(run).rejects.toThrow('timed out');
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(operationSignal.aborted).toBe(true);
  });

  it('extends the deadline whenever the operation reports progress', async () => {
    vi.useFakeTimers();
    let heartbeat!: () => void;
    let finish!: (value: string) => void;
    const result = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const run = withInactivityTimeout((reportProgress) => {
      heartbeat = reportProgress;
      return result;
    }, 100);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(90);
    heartbeat();
    await vi.advanceTimersByTimeAsync(90);
    finish('done');

    await expect(run).resolves.toBe('done');
  });

  it('preserves operation errors and clears the timeout after settlement', async () => {
    vi.useFakeTimers();
    const failure = new Error('adapter failed');
    const run = withInactivityTimeout(async () => {
      throw failure;
    }, 100);

    await expect(run).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows multiple bounded queue waves when each wave reports progress', async () => {
    vi.useFakeTimers();
    const settled: number[] = [];
    const run = withInactivityTimeout(
      (heartbeat) => runDraftQueue({
        items: [1, 2, 3, 4],
        concurrency: 2,
        promptFor: String,
        draftAnswer: async (question) => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return question;
        },
        onSettled: (item) => {
          settled.push(item);
        },
        onProgress: heartbeat,
      }),
      100,
    );

    await vi.advanceTimersByTimeAsync(80);
    expect(settled).toEqual([1, 2]);
    await vi.advanceTimersByTimeAsync(80);

    await expect(run).resolves.toBeUndefined();
    expect(settled).toEqual([1, 2, 3, 4]);
  });
});
