// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { fillGenericApplication } from './generic';
import { setNativeValue, isHoneypotField } from './shared/dom';
import type { ApplicationProfile, Profile } from '../types';

// Issue #33. Workday ships a bot trap on its sign-in AND create-account forms
// (`data-automation-id="beecatcher"`, labelled "Enter website. This input is for robots only, do
// not enter if you're human"), measured live on nvidia.wd5.myworkdayjobs.com 2026-07-23:
//
//   display: block   visibility: visible   opacity: 1   tabIndex: 0
//   position: absolute   clip: rect(1px, 1px, 1px, 1px)   1px x 1px
//
// It passes generic.ts's isVisible() (which tests only display/visibility), so the adapter treated
// it as an ordinary fillable input - and its label reads "Enter website", exactly the shape the
// link/website matcher answers. A value in a honeypot marks the whole submission as bot traffic and
// the application can be discarded with no error shown to the student.

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
  portfolio_url: 'https://mehek-site.vercel.app',
};

function markReactManaged(el: Element): void {
  (el as unknown as Record<string, unknown>)['__reactFiber$test'] = {};
}

function wrapper(labelText: string, control: HTMLElement): HTMLElement {
  const w = document.createElement('div');
  const label = document.createElement('label');
  label.textContent = labelText;
  // Explicit for/id association: without it the adapter cannot read the question and fills nothing,
  // which would make the "trap stayed empty" assertion below pass for the wrong reason.
  if (control.id) label.htmlFor = control.id;
  w.appendChild(label);
  w.appendChild(control);
  document.body.appendChild(w);
  return w;
}

// jsdom reports every rect as 0x0, and generic.ts's isVisible() rejects those, so without stubbing
// nothing is ever a candidate and every assertion here would pass for free. Sizes are chosen to
// mirror the live page: ordinary fields get a real box, the trap keeps its actual 1x1. That matters
// because a 1x1 box still passes isVisible() (only 0x0 fails) - which is exactly why the live bug
// existed and why the guard, not the visibility test, is what has to catch it.
function stubRect(el: HTMLElement, width: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
}

function textInput(id: string, type = 'text'): HTMLInputElement {
  const el = document.createElement('input');
  el.type = type;
  el.id = id;
  stubRect(el, 200, 32);
  return el;
}

// The live trap, reproduced attribute for attribute.
function honeypotInput(): HTMLInputElement {
  const el = textInput('beecatcher-field');
  el.setAttribute('data-automation-id', 'beecatcher');
  el.style.cssText = 'position:absolute;clip:rect(1px, 1px, 1px, 1px);width:1px;height:1px';
  stubRect(el, 1, 1);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('setNativeValue honeypot backstop', () => {
  // Guarded at the write primitive, not just at collection: fillField() is NOT a universal
  // chokepoint (ashby and generic call setNativeValue directly in a dozen places), so a
  // collection-only guard would leave real paths open.
  it('refuses to write into a bot trap', () => {
    const trap = honeypotInput();
    document.body.appendChild(trap);
    setNativeValue(trap, 'https://mehek-site.vercel.app');
    expect(trap.value).toBe('');
  });

  it('still writes to an ordinary field', () => {
    const real = textInput('website');
    document.body.appendChild(real);
    setNativeValue(real, 'https://mehek-site.vercel.app');
    expect(real.value).toBe('https://mehek-site.vercel.app');
  });

  it('does not misclassify a normal visible input', () => {
    const real = textInput('website');
    document.body.appendChild(real);
    expect(isHoneypotField(real)).toBe(false);
  });
});

describe('generic adapter fill against a live-shaped honeypot', () => {
  it('fills the real website field and leaves the bot trap empty', async () => {
    const first = textInput('first_name');
    const last = textInput('last_name');
    const email = textInput('email', 'email');
    for (const el of [first, last, email]) markReactManaged(el);
    wrapper('First Name*', first);
    wrapper('Last Name*', last);
    wrapper('Email*', email);

    // A genuine website question, and the trap that imitates one.
    const realSite = textInput('portfolio');
    markReactManaged(realSite);
    wrapper('Website', realSite);

    const trap = honeypotInput();
    markReactManaged(trap);
    wrapper("Enter website. This input is for robots only, do not enter if you're human.", trap);

    const result = await fillGenericApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: ap,
    });

    // The point of the test.
    expect(trap.value).toBe('');
    // Sanity: the adapter really did run and write to this form, so an empty trap means "guarded",
    // not "the fill silently did nothing and the assertion above passed for free".
    expect(result.fields_filled).toBeGreaterThan(0);
  });
});
