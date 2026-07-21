// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createResumeGenerationController,
  createResumeReviewPrompt,
  createSubmissionOutcomeController,
  restoreResumeReviewControls,
} from './application-task-controller';

beforeEach(() => {
  document.body.innerHTML = '';
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('application task orchestration', () => {
  it('keeps a retry message visible across later timer ticks', () => {
    const status = document.createElement('div');
    const announcer = document.createElement('div');
    const controller = createResumeGenerationController({ statusElement: status, announcerElement: announcer });

    controller.tick(24);
    controller.retry(1);
    controller.tick(40);

    expect(status.textContent).toBe('The AI is busy right now. Retrying... (attempt 2)');
    expect(announcer.textContent).toBe('The resume service is busy. Retrying attempt 2.');
  });

  it('debounces scans, lets a later failure replace an incomplete-form wait, and prefers failure', () => {
    let portalText = 'Application form';
    const outcomes: unknown[] = [];
    const onStop = vi.fn();
    const readText = vi.fn(() => portalText);
    const controller = createSubmissionOutcomeController({
      readText,
      onOutcome: (outcome) => outcomes.push(outcome),
      onUnknown: vi.fn(),
      onStop,
    });

    controller.queueScan();
    controller.queueScan();
    vi.advanceTimersByTime(200);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual([]);

    portalText = "Application submitted. We couldn't submit your application because it was possible spam.";
    controller.queueScan();
    vi.advanceTimersByTime(200);

    expect(outcomes).toEqual([{
      kind: 'failure',
      message: 'The company portal rejected this submission as possible spam. Review the form before trying again.',
    }]);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('tears down monitoring at the deadline and when closed', () => {
    const timedOutStop = vi.fn();
    const onUnknown = vi.fn();
    createSubmissionOutcomeController({
      readText: () => '',
      onOutcome: vi.fn(),
      onUnknown,
      onStop: timedOutStop,
    });
    vi.advanceTimersByTime(60_000);
    expect(onUnknown).toHaveBeenCalledTimes(1);
    expect(timedOutStop).toHaveBeenCalledTimes(1);

    const closedStop = vi.fn();
    const closedUnknown = vi.fn();
    const closed = createSubmissionOutcomeController({
      readText: () => '',
      onOutcome: vi.fn(),
      onUnknown: closedUnknown,
      onStop: closedStop,
    });
    closed.stop();
    vi.advanceTimersByTime(60_000);
    expect(closedStop).toHaveBeenCalledTimes(1);
    expect(closedUnknown).not.toHaveBeenCalled();
  });

  it('focuses the replacement review action and restores focus after Not now', async () => {
    const status = document.createElement('div');
    const yes = document.createElement('button');
    const no = document.createElement('button');
    document.body.append(status, yes, no);
    const approval = createResumeReviewPrompt({
      statusElement: status,
      yesButton: yes,
      noButton: no,
      summary: 'Review this resume.',
      announce: vi.fn(),
    });

    const cancel = [...status.querySelectorAll('button')].find((button) => button.textContent === 'Not now')!;
    expect(document.activeElement?.textContent).toBe('Attach and fill');
    cancel.click();
    expect(await approval).toBe(false);
    restoreResumeReviewControls({ statusElement: status, yesButton: yes, noButton: no });
    expect(document.activeElement).toBe(yes);
    expect(yes.textContent).toBe('Review again');
  });

  it('keeps review rows readable under hostile portal line-height CSS', async () => {
    const style = document.createElement('style');
    style.textContent = 'div, button { line-height: 0; }';
    const status = document.createElement('div');
    const yes = document.createElement('button');
    const no = document.createElement('button');
    document.head.append(style);
    document.body.append(status, yes, no);
    void createResumeReviewPrompt({
      statusElement: status,
      yesButton: yes,
      noButton: no,
      summary: 'Review this resume.',
      announce: vi.fn(),
    });

    const actions = status.querySelector('div')!;
    const attach = status.querySelector('button')!;
    expect(getComputedStyle(actions).lineHeight).toBe('1.4');
    expect(getComputedStyle(attach).lineHeight).toBe('1.4');
  });
});
