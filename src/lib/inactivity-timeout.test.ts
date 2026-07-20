import { afterEach, describe, expect, it, vi } from 'vitest';
import { withInactivityTimeout } from './inactivity-timeout';

describe('withInactivityTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects an operation that stops making progress', async () => {
    vi.useFakeTimers();
    const run = withInactivityTimeout(() => new Promise<string>(() => {}), 100);
    const rejection = expect(run).rejects.toThrow('timed out');

    await vi.advanceTimersByTimeAsync(100);

    await rejection;
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
});
