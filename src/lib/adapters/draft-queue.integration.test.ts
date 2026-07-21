// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fillGenericApplication } from './generic';
import { fillLeverApplication } from './lever';
import { fillLinkedInApplication } from './linkedin';
import { fillWorkdayApplication } from './workday';
import type { AutofillResult, Profile } from '../types';

// These are deliberately adapter-level smoke tests rather than another unit test of runDraftQueue.
// They prove that each adapter still discovers its own DOM shape, sends the readable question to
// the shared queue, writes a successful answer, and turns a failed request into a reviewable skip.

const profile = {
  experience: [],
  skills: [],
  school: 'USC',
  grad_year: 2028,
} as Profile;

const QUESTION = 'Why do you want to join Litos?';
const NORMALIZED_QUESTION = QUESTION.toLowerCase();
const DRAFT = 'I want to help students apply with more confidence.';

const RECT = {
  width: 320,
  height: 100,
  top: 0,
  left: 0,
  right: 320,
  bottom: 100,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect;

interface AdapterHarness {
  name: string;
  setup: () => HTMLTextAreaElement;
  run: (draftAnswer: (question: string) => Promise<string | null>) => Promise<AutofillResult>;
}

function labelledTextarea(parent: HTMLElement): HTMLTextAreaElement {
  const label = document.createElement('label');
  const textarea = document.createElement('textarea');
  textarea.getBoundingClientRect = () => RECT;
  label.textContent = QUESTION;
  label.appendChild(textarea);
  parent.appendChild(label);
  return textarea;
}

const harnesses: AdapterHarness[] = [
  {
    name: 'Generic',
    setup: () => {
      const wrapper = document.createElement('div');
      document.body.appendChild(wrapper);
      return labelledTextarea(wrapper);
    },
    run: (draftAnswer) => fillGenericApplication({
      fullName: '',
      profile,
      applicationProfile: {},
      draftAnswer,
    }),
  },
  {
    name: 'Lever',
    setup: () => {
      const block = document.createElement('div');
      block.className = 'application-question';
      document.body.appendChild(block);
      return labelledTextarea(block);
    },
    run: (draftAnswer) => fillLeverApplication({
      fullName: '',
      profile,
      applicationProfile: {},
      draftAnswer,
    }),
  },
  {
    name: 'Workday',
    setup: () => {
      const fieldset = document.createElement('fieldset');
      document.body.appendChild(fieldset);
      return labelledTextarea(fieldset);
    },
    run: (draftAnswer) => fillWorkdayApplication({
      fullName: '',
      profile,
      applicationProfile: {},
      draftAnswer,
    }),
  },
  {
    name: 'LinkedIn',
    setup: () => {
      const modal = document.createElement('div');
      modal.setAttribute('data-test-modal-id', 'easy-apply-modal');
      const block = document.createElement('div');
      block.className = 'fb-dash-form-element';
      modal.appendChild(block);
      document.body.appendChild(modal);
      return labelledTextarea(block);
    },
    run: (draftAnswer) => fillLinkedInApplication({
      fullName: '',
      profile,
      applicationProfile: {},
      draftAnswer,
    }),
  },
];

beforeAll(() => {
  if (typeof globalThis.CSS === 'undefined' || !globalThis.CSS.escape) {
    (globalThis as Record<string, unknown>).CSS = {
      escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`),
    };
  }
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe.each(harnesses)('$name adapter through the shared draft queue', ({ setup, run }) => {
  it('writes and flags a successful draft', async () => {
    const textarea = setup();
    const draftAnswer = vi.fn(async () => `  ${DRAFT}  `);

    const result = await run(draftAnswer);

    expect(draftAnswer).toHaveBeenCalledOnce();
    expect(draftAnswer).toHaveBeenCalledWith(NORMALIZED_QUESTION);
    expect(textarea.value).toBe(DRAFT);
    expect(textarea.style.outline).toContain('2px');
    expect(result.ai_drafted).toBe(1);
    expect(result.fields_filled).toBeGreaterThanOrEqual(1);
    expect(result.skipped_reasons[0]).toMatch(/1 open-ended answer AI-drafted/);
  });

  it('leaves the field blank and reports a failed draft', async () => {
    const textarea = setup();
    const draftAnswer = vi.fn(async () => {
      throw new Error('draft endpoint unavailable');
    });

    const result = await run(draftAnswer);

    expect(draftAnswer).toHaveBeenCalledOnce();
    expect(draftAnswer).toHaveBeenCalledWith(NORMALIZED_QUESTION);
    expect(textarea.value).toBe('');
    expect(textarea.style.outline).toBe('');
    expect(result.ai_drafted).toBe(0);
    expect(result.fields_skipped).toBeGreaterThanOrEqual(1);
    expect(result.skipped_reasons).toContain(
      `open-ended question left blank: "${NORMALIZED_QUESTION}"`,
    );
  });
});
