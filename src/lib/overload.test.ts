import { describe, it, expect } from 'vitest';
import { overloadWaitMs, overloadBudgetRemains, RESUME_OVERLOAD_BUDGET_MS } from './overload';

// R-003 (live QA 2026-07-16): a real Anthropic overload incident hard-failed a whole fill. The card
// said "Failed to generate resume spec" and the student's only recovery was re-clicking "Yes, fill
// it" - 6+ times on Global Relay, never succeeding while the incident lasted, blocking submission
// #8 outright. The backend cannot fix this alone (Vercel kills the function at 60s; recovery took
// ~2.5 min), so this client-side wait policy is load-bearing.

describe('overloadWaitMs', () => {
  it('honors a usable server hint', () => {
    expect(overloadWaitMs(5000, () => 0)).toBe(5000);
    expect(overloadWaitMs(1200, () => 0)).toBe(1200);
  });

  it('clamps a large hint so one sleep cannot eat the whole retry budget', () => {
    // A server hint is advice, not a budget. Obeying 120s literally would spend the entire 150s
    // window in a single wait, turning "~6 attempts over 2.5 min" (what actually recovered the live
    // incident) into "one attempt, then give up".
    expect(overloadWaitMs(120000, () => 0)).toBe(15000);
    expect(overloadWaitMs(60000, () => 0)).toBe(15000);
  });

  it('falls back to the default when the hint is missing or unusable', () => {
    expect(overloadWaitMs(undefined, () => 0)).toBe(5000);
    expect(overloadWaitMs(null, () => 0)).toBe(5000);
    expect(overloadWaitMs(0, () => 0)).toBe(5000);
    expect(overloadWaitMs(-1, () => 0)).toBe(5000);
    expect(overloadWaitMs(NaN, () => 0)).toBe(5000);
    expect(overloadWaitMs('soon', () => 0)).toBe(5000);
  });

  it('always returns a finite, non-negative wait', () => {
    // A NaN wait would become setTimeout(NaN) = fire immediately = a tight retry loop hammering an
    // API that is already shedding load.
    for (const hint of [undefined, null, NaN, Infinity, -Infinity, 'x', {}, 5000]) {
      const ms = overloadWaitMs(hint);
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('adds jitter, so a fleet of clients cannot synchronize into a thundering herd', () => {
    // Every client retrying a SHARED incident on an identical schedule is the failure mode.
    const samples = new Set(Array.from({ length: 40 }, () => overloadWaitMs(5000)));
    expect(samples.size).toBeGreaterThan(1);
  });

  it('keeps jitter small enough not to distort the wait', () => {
    expect(overloadWaitMs(5000, () => 0.999)).toBeLessThan(5400);
    expect(overloadWaitMs(5000, () => 0)).toBe(5000);
  });
});

describe('overloadBudgetRemains', () => {
  it('allows retries until the deadline and stops after', () => {
    const deadline = 10_000;
    expect(overloadBudgetRemains(deadline, 9_999)).toBe(true);
    expect(overloadBudgetRemains(deadline, 10_000)).toBe(false);
    expect(overloadBudgetRemains(deadline, 10_001)).toBe(false);
  });

  it('budgets enough time to actually outlast the observed incident', () => {
    // The live incident's manual poll took ~2.5 min to get a 200. A budget under that would ship a
    // retry that cannot survive the exact failure it was built for.
    expect(RESUME_OVERLOAD_BUDGET_MS).toBeGreaterThanOrEqual(150000);
  });
});
