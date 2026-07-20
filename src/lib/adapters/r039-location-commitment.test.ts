// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  fillGenericApplication,
  locationQuestion,
  drainR030CandidateLabels,
  noteR039Candidate,
} from './generic';
import type { ApplicationProfile, Profile } from '../types';

// R-039 through the REAL fill paths. The pure veto is pinned in classify.test.ts; what these
// cases prove is the two halves that actually run on a form: the generic identity chain's city
// leg (the register's original R-039 site) and locationQuestion (the site the two live labels
// took - Greenhouse routes its custom questions through it). Both live labels are asserted in
// their observed direction (no city lands) AND the R-002 direction is re-pinned (real residence
// asks keep filling), because every location guard in this repo that skipped one direction
// shipped the opposite bug. The telemetry contract is pinned too: a veto is recorded on the
// r030 channel with the r039-veto: tag, third-party hits with r039-third-party:, and recording
// NEVER changes what fills.

const GEMINI_RAW =
  "This role is required to be based near our New York City, NY office. Are you open to relocating if you're not currently near NYC?";
const FAIRE_RAW =
  'This role will be in-office on a hybrid schedule, can you commit to being in-office three days per week at the SF office?';

const profile = {} as Profile;
const ap: ApplicationProfile = {
  address_city: 'Dubai',
  address_country: 'United Arab Emirates',
} as ApplicationProfile;

// The generic adapter's candidateInputs() gates on isVisible(), which reads a layout box jsdom
// never computes, so each control gets a stubbed rect (same harness as salary-fill.test.ts).
const RECT = {
  width: 200, height: 24, top: 0, left: 0, right: 200, bottom: 24, x: 0, y: 0,
  toJSON: () => ({}),
} as DOMRect;

let seq = 0;
function genericField(labelText: string): HTMLInputElement {
  const id = `field-${++seq}`;
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;
  const el = document.createElement('input');
  el.type = 'text';
  el.id = id;
  el.getBoundingClientRect = () => RECT;
  document.body.append(label, el);
  return el;
}

function runGeneric(applicationProfile: ApplicationProfile) {
  return fillGenericApplication({
    fullName: 'Mehek Mandal',
    email: 'mehekman@usc.edu',
    profile,
    applicationProfile,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  seq = 0;
  drainR030CandidateLabels(); // isolate: no labels leak between tests
});

describe('R-039 veto through the generic identity chain', () => {
  it('the Gemini live label gets NO city, and the veto is recorded', async () => {
    const el = genericField(GEMINI_RAW);
    await runGeneric(ap);
    expect(el.value).toBe(''); // never "Dubai"
    const labels = drainR030CandidateLabels();
    expect(labels.some((l) => l.startsWith('r039-veto:') && /relocating/.test(l))).toBe(true);
  });

  it('a real residence ask still fills, with nothing recorded (R-002 direction)', async () => {
    const el = genericField('Location (City)');
    await runGeneric(ap);
    expect(el.value).toBe('Dubai');
    expect(drainR030CandidateLabels().filter((l) => l.startsWith('r039-'))).toEqual([]);
  });

  it("a third-party label is RECORDED but the fill is unchanged (observation only, R-030 doctrine)", async () => {
    const el = genericField("Manager's email");
    await runGeneric(ap);
    // Today's behavior: the bare e-?mail matcher fills her email. That is R-039's still-open
    // shape - the point of this test is that instrumenting it did NOT quietly become a guard.
    // When a real guard is designed off the recorded labels, THIS assertion is the one to flip.
    expect(el.value).toBe('mehekman@usc.edu');
    const labels = drainR030CandidateLabels();
    expect(labels.some((l) => l.startsWith('r039-third-party:') && /manager/.test(l))).toBe(true);
  });
});

describe('R-039 veto at locationQuestion (the live labels took this path on Greenhouse)', () => {
  it('both live labels return null and are recorded', () => {
    expect(locationQuestion(GEMINI_RAW, ap)).toBeNull();
    expect(locationQuestion(FAIRE_RAW, ap)).toBeNull();
    const labels = drainR030CandidateLabels();
    expect(labels).toHaveLength(2);
    expect(labels.every((l) => l.startsWith('r039-veto:'))).toBe(true);
  });

  it('a real residence ask still resolves her city', () => {
    expect(locationQuestion('Location (City)*', ap)).toEqual({ field: 'city', value: 'Dubai' });
    expect(drainR030CandidateLabels()).toEqual([]);
  });

  it('a work-eligibility label with location vocabulary stays on its own refusal, out of the sample', () => {
    expect(locationQuestion('Are you authorized to work in the location where this role is based?', ap)).toBeNull();
    expect(drainR030CandidateLabels()).toEqual([]);
  });
});

describe('noteR039Candidate contract', () => {
  it('tags, truncates to the backend max, and caps under the zod array bound', () => {
    noteR039Candidate('veto', 'x'.repeat(500));
    const [long] = drainR030CandidateLabels();
    expect(long.startsWith('r039-veto:')).toBe(true);
    expect(long.length).toBe(200); // the zod per-string bound

    for (let i = 0; i < 60; i++) noteR039Candidate('third-party', `label ${i}`);
    // Capped at 40 so link candidates keep headroom and the event can never exceed zod's max(50).
    expect(drainR030CandidateLabels()).toHaveLength(40);
  });
});
