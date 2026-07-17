// @vitest-environment jsdom
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { fillGenericApplication } from './generic';
import { fillAshbyApplication } from './ashby';
import { skippedReasonsNeedReview } from '../autosubmit-gate';
import type { ApplicationProfile, Profile } from '../types';

// The pure classifier is pinned in languages.test.ts; this file proves the ADAPTER WIRING, which
// is where R-006's lesson lives: the loop that reads a label and decides which branch owns the
// block can intercept a question before the right classifier ever sees it. Runs the real
// fillGenericApplication and fillAshbyApplication against their own markup shapes (the same
// one-file jsdom exception ashby-essay-draft.test.ts carved out).

const ZURU =
  'This role involves working closely with our team in Mexico, so Spanish language skills are ' +
  'preferred but not essential. Are you comfortable communicating in Spanish in a professional setting?';
const declared = ['English', 'Hindi', 'Arabic', 'French'];

const profile = {} as Profile;
const ap = (o: Partial<ApplicationProfile> = {}): ApplicationProfile => o as ApplicationProfile;

beforeAll(() => {
  // The generic adapter filters every control through isVisible(), and jsdom has no layout: every
  // rect is 0x0, so nothing would ever be considered. Give every element a real-looking box.
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: 120, height: 24, top: 0, left: 0, right: 120, bottom: 24, x: 0, y: 0, toJSON: () => ({}) }),
  });
  // This vitest jsdom environment exposes no CSS global, and the option-label lookups go through
  // CSS.escape. The ids in these fixtures are plain, so a minimal escape suffices.
  if (typeof globalThis.CSS === 'undefined' || !globalThis.CSS?.escape) {
    (globalThis as Record<string, unknown>).CSS = {
      escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
    };
  }
});

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('fillGenericApplication: language questions', () => {
  function radioFieldset(legendText: string, name: string, options: string[]): Record<string, HTMLInputElement> {
    const fs = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = legendText;
    fs.appendChild(legend);
    const els: Record<string, HTMLInputElement> = {};
    options.forEach((opt, i) => {
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = name;
      r.id = `${name}_${i}`;
      const optionLabel = document.createElement('label');
      optionLabel.htmlFor = r.id;
      optionLabel.textContent = opt;
      fs.appendChild(r);
      fs.appendChild(optionLabel);
      els[opt] = r;
    });
    document.body.appendChild(fs);
    return els;
  }

  function labelledSelect(labelText: string, options: string[]): HTMLSelectElement {
    const select = document.createElement('select');
    select.id = 'lang_level';
    const label = document.createElement('label');
    label.htmlFor = select.id;
    label.textContent = labelText;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select...';
    select.appendChild(placeholder);
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      select.appendChild(o);
    }
    document.body.appendChild(label);
    document.body.appendChild(select);
    return select;
  }

  function run(languages?: string[], draftAnswer?: (q: string) => Promise<string | null>) {
    return fillGenericApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: ap({ languages }),
      draftAnswer,
    });
  }

  it('ZURU radios, Spanish not declared: No + review flag that holds auto-submit', async () => {
    const radios = radioFieldset(ZURU, 'zuru', ['Yes', 'No']);

    const result = await run(declared);

    expect(radios['No'].checked).toBe(true);
    expect(radios['Yes'].checked).toBe(false);
    expect(result.skipped_reasons.some((r) => /answered No \(spanish is not in your declared languages\)/.test(r))).toBe(true);
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  });

  it('ZURU radios, Spanish declared: a clean Yes', async () => {
    const radios = radioFieldset(ZURU, 'zuru', ['Yes', 'No']);

    const result = await run([...declared, 'Spanish']);

    expect(radios['Yes'].checked).toBe(true);
    expect(result.skipped_reasons.some((r) => /language|declared languages/.test(r))).toBe(false);
  });

  it('German level select, German not declared: lowest honest option + review flag', async () => {
    const select = labelledSelect('German level', ['No knowledge', 'B2', 'C1', 'Native']);

    const result = await run(declared);

    expect(select.value).toBe('No knowledge');
    expect(result.skipped_reasons.some((r) => /picked the lowest german level.*review before submitting/.test(r))).toBe(true);
  });

  it('English level select, English declared: fluent tier, never Native', async () => {
    const select = labelledSelect('English level', ['Basic', 'Fluent', 'Native']);

    await run(declared);

    expect(select.value).toBe('Fluent');
  });

  it('a language question rendered as a textarea is flagged, never drafted', async () => {
    const ta = document.createElement('textarea');
    ta.id = 'lang_essay';
    const label = document.createElement('label');
    label.htmlFor = ta.id;
    label.textContent = ZURU;
    document.body.appendChild(label);
    document.body.appendChild(ta);
    const draftAnswer = vi.fn(async (_q: string) => 'should never be called for a language question');

    const result = await run(declared, draftAnswer);

    expect(draftAnswer).not.toHaveBeenCalled();
    expect(ta.value).toBe('');
    expect(result.skipped_reasons.some((r) => /language question left for you/.test(r))).toBe(true);
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  });

  it('empty declared list: nothing selected, always-ask flag holds', async () => {
    const radios = radioFieldset(ZURU, 'zuru', ['Yes', 'No']);

    const result = await run(undefined);

    expect(radios['Yes'].checked).toBe(false);
    expect(radios['No'].checked).toBe(false);
    expect(result.skipped_reasons.some((r) => /no languages declared/.test(r))).toBe(true);
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  });
});

describe('fillAshbyApplication: language questions', () => {
  function fieldEntry(inner: string): HTMLElement {
    const fieldset = document.createElement('fieldset');
    fieldset.className = '_fieldEntry_lang1';
    fieldset.innerHTML = inner;
    document.body.appendChild(fieldset);
    return fieldset;
  }

  function run(languages?: string[], draftAnswer?: (q: string) => Promise<string | null>) {
    return fillAshbyApplication({
      fullName: '',
      profile,
      applicationProfile: ap({ languages }),
      draftAnswer,
    });
  }

  it('ZURU radios (label text on label[for], Ashby value="on"): No + review flag', async () => {
    fieldEntry(
      `<legend>${ZURU}</legend>` +
        '<input type="radio" id="zr_1" name="zr" value="on" /><label for="zr_1">Yes</label>' +
        '<input type="radio" id="zr_2" name="zr" value="on" /><label for="zr_2">No</label>',
    );

    const result = await run(declared);

    expect((document.getElementById('zr_2') as HTMLInputElement).checked).toBe(true);
    expect((document.getElementById('zr_1') as HTMLInputElement).checked).toBe(false);
    expect(result.skipped_reasons.some((r) => /answered No \(spanish is not in your declared languages\)/.test(r))).toBe(true);
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  }, 20000);

  it('ZURU radios with Spanish declared: a clean Yes', async () => {
    fieldEntry(
      `<legend>${ZURU}</legend>` +
        '<input type="radio" id="zr_1" name="zr" value="on" /><label for="zr_1">Yes</label>' +
        '<input type="radio" id="zr_2" name="zr" value="on" /><label for="zr_2">No</label>',
    );

    const result = await run([...declared, 'Spanish']);

    expect((document.getElementById('zr_1') as HTMLInputElement).checked).toBe(true);
    expect(result.skipped_reasons.some((r) => /language|declared languages/.test(r))).toBe(false);
  }, 20000);

  it('a language question rendered as a textarea is flagged, never drafted', async () => {
    fieldEntry(`<label>${ZURU}</label><textarea></textarea>`);
    const draftAnswer = vi.fn(async (_q: string) => 'should never be called for a language question');

    const result = await run(declared, draftAnswer);

    expect(draftAnswer).not.toHaveBeenCalled();
    expect(document.querySelector('textarea')!.value).toBe('');
    expect(result.skipped_reasons.some((r) => /language question left for you/.test(r))).toBe(true);
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  }, 20000);

  it('empty declared list: always-ask, nothing checked, flag holds', async () => {
    fieldEntry(
      `<legend>${ZURU}</legend>` +
        '<input type="radio" id="zr_1" name="zr" value="on" /><label for="zr_1">Yes</label>' +
        '<input type="radio" id="zr_2" name="zr" value="on" /><label for="zr_2">No</label>',
    );

    const result = await run(undefined);

    expect((document.getElementById('zr_1') as HTMLInputElement).checked).toBe(false);
    expect((document.getElementById('zr_2') as HTMLInputElement).checked).toBe(false);
    expect(result.skipped_reasons.some((r) => /no languages declared/.test(r))).toBe(true);
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  }, 20000);
});
