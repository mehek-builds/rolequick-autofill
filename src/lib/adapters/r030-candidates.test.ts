// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { fillGreenhouseApplication } from './greenhouse';
import { drainR030CandidateLabels, linkQuestion, noteLinkFillCandidate } from './generic';
import type { ApplicationProfile, Profile } from '../types';

// R-030 instrumentation, observation ONLY. The register forbids fixing the classifier from first
// principles (two invented guards in a row each produced the opposite bug, and asksForLink is
// provably not the discriminator), so the shipped change is exactly its cheapest next step:
// record the labels of the population that fills a URL unconditionally - linkQuestion non-null,
// asksForLink false, control input[type=text] - and post them with the autofill telemetry. These
// tests pin BOTH halves of that contract: the label is captured, and the fill itself is
// byte-identical to before (the URL still lands; nothing new is vetoed).

const profile: Profile = {
  full_name: 'Mehek Mandal',
  email: 'mehekman@usc.edu',
  experience: [],
  skills: [],
  school: 'USC',
  grad_year: 2028,
};

const ap: ApplicationProfile = {
  linkedin_url: 'https://linkedin.com/in/mehek',
  github_url: 'https://github.com/mehek-builds',
};

// Mark a node as framework-managed the way React does (fiber expando), so the R-032 verify pass
// exits on its first read-back and these tests stay fast while running the production code path.
function markReactManaged(el: Element): void {
  (el as unknown as Record<string, unknown>)['__reactFiber$test'] = {};
}

function wrapper(labelText: string, control: HTMLElement): HTMLElement {
  const w = document.createElement('div');
  w.className = 'field-wrapper';
  const label = document.createElement('label');
  label.textContent = labelText;
  w.appendChild(label);
  w.appendChild(control);
  document.body.appendChild(w);
  return w;
}

function textInput(id: string, type = 'text'): HTMLInputElement {
  const el = document.createElement('input');
  el.type = type;
  el.id = id;
  return el;
}

function coreFields(): void {
  const first = textInput('first_name');
  const last = textInput('last_name');
  const email = textInput('email', 'email');
  for (const el of [first, last, email]) markReactManaged(el);
  wrapper('First Name*', first);
  wrapper('Last Name*', last);
  wrapper('Email*', email);
}

beforeEach(() => {
  document.body.innerHTML = '';
  drainR030CandidateLabels(); // isolate: no labels leak between tests
});

describe('R-030 candidate labels through a real adapter fill', () => {
  it(
    'captures the label of an essay-shaped text input AND still fills the URL exactly as before',
    async () => {
      coreFields();
      // R-030's shape: the platform is an incidental product noun, not the subject, yet
      // /github/i commits. Today this fills the URL; the instrumentation must observe that
      // WITHOUT changing it.
      const essayish = textInput('question_1');
      markReactManaged(essayish);
      wrapper('Do you have experience with GitHub Actions?', essayish);

      const result = await fillGreenhouseApplication({
        fullName: 'Mehek Mandal',
        email: 'mehekman@usc.edu',
        profile,
        applicationProfile: ap,
      });

      // Fill behavior unchanged: the URL still lands, and it still counts as filled.
      expect(essayish.value).toBe('https://github.com/mehek-builds');
      expect(result.fields_filled).toBe(4); // first, last, email, github

      // And the label was recorded for telemetry (as the classifier saw it: lowercased).
      const labels = drainR030CandidateLabels();
      expect(labels).toHaveLength(1);
      expect(labels[0]).toMatch(/github actions/i);
    },
    20000,
  );

  it(
    'does NOT record a genuine link question (asksForLink true), which also still fills',
    async () => {
      coreFields();
      const linkField = textInput('question_1');
      markReactManaged(linkField);
      wrapper('GitHub profile URL', linkField);

      await fillGreenhouseApplication({
        fullName: 'Mehek Mandal',
        email: 'mehekman@usc.edu',
        profile,
        applicationProfile: ap,
      });

      expect(linkField.value).toBe('https://github.com/mehek-builds');
      expect(drainR030CandidateLabels()).toEqual([]);
    },
    20000,
  );
});

describe('noteLinkFillCandidate population edges (pure recording, never a gate)', () => {
  const essayLink = () => linkQuestion('do you have experience with github actions?', ap)!;

  it('records only input[type=text]: url inputs and textareas are out of the population', () => {
    const urlInput = document.createElement('input');
    urlInput.type = 'url';
    const textarea = document.createElement('textarea');
    noteLinkFillCandidate('experience with github?', essayLink(), urlInput);
    noteLinkFillCandidate('experience with github?', essayLink(), textarea);
    noteLinkFillCandidate('experience with github?', essayLink(), null);
    expect(drainR030CandidateLabels()).toEqual([]);

    const textEl = document.createElement('input');
    textEl.type = 'text';
    noteLinkFillCandidate('experience with github?', essayLink(), textEl);
    expect(drainR030CandidateLabels()).toEqual(['experience with github?']);
  });

  it('never records when the label genuinely asks for a link', () => {
    const link = linkQuestion('please share your github profile', ap)!;
    expect(link.asksForLink).toBe(true);
    const textEl = document.createElement('input');
    textEl.type = 'text';
    noteLinkFillCandidate('please share your github profile', link, textEl);
    expect(drainR030CandidateLabels()).toEqual([]);
  });

  it('drain clears: labels from one run can never leak into the next report', () => {
    const textEl = document.createElement('input');
    textEl.type = 'text';
    noteLinkFillCandidate('experience with github?', essayLink(), textEl);
    expect(drainR030CandidateLabels()).toHaveLength(1);
    expect(drainR030CandidateLabels()).toEqual([]);
  });
});
