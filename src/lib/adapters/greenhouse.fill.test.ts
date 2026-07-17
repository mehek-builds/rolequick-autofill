// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fillGreenhouseApplication } from './greenhouse';
import type { ApplicationProfile, Profile } from '../types';

// R-032 + R-033 against the real adapter in a Greenhouse-shaped DOM. The R-032 half exercises the
// exact live failure: a fill that lands pre-hydration, gets wiped by hydration, and used to be
// counted anyway ("Filled 5 fields" over an empty First/Last/Email); and the phone country-code
// split that intl-tel-input turned into a local number. The R-033 half exercises the required
// open-ended input[type=text] the drafter never reached. Per the repo's standing lesson, every
// fix is tested in BOTH directions: the forms that fill correctly today must keep filling.

const profile: Profile = {
  full_name: 'Mehek Mandal',
  email: 'mehekman@usc.edu',
  experience: [],
  skills: [],
  school: 'USC',
  grad_year: 2028,
};

const ap: ApplicationProfile = {
  phone: '+971 567417451',
  address_city: 'Dubai',
  linkedin_url: 'https://linkedin.com/in/mehek',
  github_url: 'https://github.com/mehek-builds',
};

const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

// Mark a node as framework-managed the way React does (fiber expando). Pre-marking inputs makes
// the verify pass exit on its first read-back, keeping the non-hydration tests fast while still
// running the production code path.
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

function coreFields(): { first: HTMLInputElement; last: HTMLInputElement; email: HTMLInputElement } {
  const first = textInput('first_name');
  const last = textInput('last_name');
  const email = textInput('email', 'email');
  wrapper('First Name*', first);
  wrapper('Last Name*', last);
  wrapper('Email*', email);
  return { first, last, email };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('R-032: hydration-reverted core fields', () => {
  it(
    're-fills what hydration wiped and counts only what persisted',
    async () => {
      const { first, last, email } = coreFields();
      const phone = textInput('phone', 'tel');
      wrapper('Phone', phone);

      // Hydration, as measured live: some time AFTER the fill writes the core fields, React
      // mounts, wipes them back to its own empty state, and adopts EVERY node (phone included,
      // which is why the later-written phone survived on Cresta). Keyed off the email write
      // (the last core write) so the timing tracks the fill instead of racing it.
      email.addEventListener('input', () => {
        setTimeout(() => {
          for (const el of [first, last, email]) {
            nativeSet.call(el, '');
            markReactManaged(el);
          }
          markReactManaged(phone); // adopted, not wiped: its write lands post-hydration
        }, 30);
      }, { once: true });

      const result = await fillGreenhouseApplication({
        fullName: 'Mehek Mandal',
        email: 'mehekman@usc.edu',
        profile,
        applicationProfile: ap,
      });

      // The point of the fix: the DOM actually holds the values afterwards...
      expect(first.value).toBe('Mehek');
      expect(last.value).toBe('Mandal');
      expect(email.value).toBe('mehekman@usc.edu');
      // ...and the count describes that DOM: first, last, email, phone all persisted.
      expect(result.fields_filled).toBe(4);
      expect(result.skipped_reasons.filter((r) => /did not keep the value/.test(r))).toEqual([]);
    },
    20000,
  );

  it(
    'un-counts and flags a field the page refuses to keep, instead of reporting it filled',
    async () => {
      const { first, last, email } = coreFields();
      // A hostile stand-in for a widget that clears every write: whatever lands in First Name is
      // asynchronously wiped, forever, so no bounded number of re-fills can make it stick.
      first.addEventListener('input', () => {
        setTimeout(() => nativeSet.call(first, ''), 5);
      });

      const result = await fillGreenhouseApplication({
        fullName: 'Mehek Mandal',
        email: 'mehekman@usc.edu',
        profile,
        applicationProfile: {},
      });

      expect(first.value).toBe('');
      expect(last.value).toBe('Mandal');
      expect(email.value).toBe('mehekman@usc.edu');
      // The card must tell the truth: 2 persisted, the third is on the "Still needs you" list
      // with wording that holds auto-submit (REVIEW_FLAG matches "left for").
      expect(result.fields_filled).toBe(2);
      expect(result.skipped_reasons.some((r) => /first name left for you: the page did not keep/.test(r))).toBe(true);
    },
    20000,
  );
});

describe('R-032: phone country-code pairing', () => {
  function uaeSelect(): HTMLSelectElement {
    const select = document.createElement('select');
    select.id = 'country';
    for (const [value, text] of [
      ['US', 'United States (+1)'],
      ['AE', 'United Arab Emirates (+971)'],
      ['GB', 'United Kingdom (+44)'],
    ]) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      select.appendChild(o);
    }
    return select;
  }

  it('selects the country from the +prefix and fills only the national number', async () => {
    const { first, last, email } = coreFields();
    for (const el of [first, last, email]) markReactManaged(el);
    const phone = textInput('phone', 'tel');
    markReactManaged(phone);
    const select = uaeSelect();
    const w = wrapper('Phone*', phone);
    w.insertBefore(select, phone);

    const changes: string[] = [];
    select.addEventListener('change', () => changes.push(select.value));

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: ap,
    });

    expect(select.value).toBe('AE');
    expect(changes).toEqual(['AE']); // committed through events, not a silent .value poke
    expect(phone.value).toBe('567417451'); // national significant number, code carried by the select
    expect(result.fields_filled).toBe(4); // first, last, email, phone-as-one-field
  });

  it('drives the intl-tel-input layout: separate #country select, .iti-wrapped number box', async () => {
    const { first, last, email } = coreFields();
    for (const el of [first, last, email]) markReactManaged(el);
    // The measured Cresta shape: #country lives in its own block, the tel input inside .iti.
    const select = uaeSelect();
    wrapper('Country', select);
    const phone = textInput('phone', 'tel');
    markReactManaged(phone);
    const iti = document.createElement('div');
    iti.className = 'iti';
    iti.appendChild(phone);
    wrapper('Phone*', iti);

    await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: ap,
    });

    expect(select.value).toBe('AE');
    expect(phone.value).toBe('567417451');
  });

  it('refuses (blank + flagged) when the selector has no option for the code, never mangling', async () => {
    const { first, last, email } = coreFields();
    for (const el of [first, last, email]) markReactManaged(el);
    const phone = textInput('phone', 'tel');
    const select = document.createElement('select');
    for (const [value, text] of [['US', 'United States (+1)'], ['GB', 'United Kingdom (+44)']]) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      select.appendChild(o);
    }
    const w = wrapper('Phone*', phone);
    w.insertBefore(select, phone);

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: ap,
    });

    // The number is NOT typed: a blank box the student fills beats "056 741 7451" going to an
    // employer with the country code silently gone.
    expect(phone.value).toBe('');
    expect(select.value).toBe('US'); // untouched default
    expect(result.skipped_reasons.some((r) => /phone left for you: no option for \+971/.test(r))).toBe(true);
  });

  it('refuses when the mangling widget is present but no country control can be driven', async () => {
    const { first, last, email } = coreFields();
    for (const el of [first, last, email]) markReactManaged(el);
    const phone = textInput('phone', 'tel');
    const iti = document.createElement('div');
    iti.className = 'iti';
    iti.appendChild(phone);
    wrapper('Phone*', iti);

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: ap,
    });

    expect(phone.value).toBe('');
    expect(result.skipped_reasons.some((r) => /reformats phone numbers/.test(r))).toBe(true);
  });

  it('keeps filling the whole number on a form with one plain phone box (no new non-fills)', async () => {
    const { first, last, email } = coreFields();
    for (const el of [first, last, email]) markReactManaged(el);
    const phone = textInput('phone', 'tel');
    markReactManaged(phone);
    wrapper('Phone*', phone);

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: ap,
    });

    // No paired control, no mangling widget: today's behavior, unchanged.
    expect(phone.value).toBe('+971 567417451');
    expect(result.fields_filled).toBe(4);
  });

  it('keeps filling a number stored without a +prefix as-is, even next to a selector', async () => {
    const { first, last, email } = coreFields();
    for (const el of [first, last, email]) markReactManaged(el);
    const phone = textInput('phone', 'tel');
    markReactManaged(phone);
    const select = uaeSelect();
    const w = wrapper('Phone*', phone);
    w.insertBefore(select, phone);

    await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: { phone: '0501234567' },
    });

    // No declared country means no safe split; never invent one.
    expect(phone.value).toBe('0501234567');
    expect(select.value).toBe('US'); // untouched default
  });
});

describe('R-033: required open-ended input[type=text]', () => {
  const GEMINI_LABEL =
    'Please share 3-5 sentences explaining your interest in the Blockchain/Web3 industry.*';

  function geminiField(): HTMLInputElement {
    const q = textInput('question_123');
    q.required = true;
    q.maxLength = 255;
    markReactManaged(q);
    wrapper(GEMINI_LABEL, q);
    return q;
  }

  function baseForm(): void {
    const { first, last, email } = coreFields();
    for (const el of [first, last, email]) markReactManaged(el);
  }

  it('drafts it through the same drafter path, with the budget declared and enforced', async () => {
    baseForm();
    const q = geminiField();
    const draftAnswer = vi.fn(async (_q: string) =>
      'Web3 fascinates me because ownership finally moves to users. I built a small on-chain project last term and the composability hooked me. ' +
      'Beyond that, I have followed the space closely since 2024 and I want to help build the tools that make it usable for people who never think about wallets.',
    );

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: {},
      draftAnswer,
    });

    // The drafter was told about the budget up front (the backend prompt takes the question as
    // free context), not just trimmed after the fact.
    expect(draftAnswer).toHaveBeenCalledTimes(1);
    expect(draftAnswer.mock.calls[0][0]).toMatch(/limited to 255 characters/);
    // The written answer fits the control and ends on a whole sentence.
    expect(q.value.length).toBeGreaterThan(0);
    expect(q.value.length).toBeLessThanOrEqual(255);
    expect(q.value.endsWith('.')).toBe(true);
    expect(result.ai_drafted).toBe(1);
    // Drafted content always holds auto-submit via the review line.
    expect(result.skipped_reasons.some((r) => /AI-drafted, review before submitting/.test(r))).toBe(true);
  });

  it('flags the required blank when the draft fails, so the card can never read as complete', async () => {
    baseForm();
    const q = geminiField();
    const draftAnswer = vi.fn(async (_q: string) => null);

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: {},
      draftAnswer,
    });

    expect(q.value).toBe('');
    expect(result.skipped_reasons.some((r) => /required open-ended question left blank/.test(r))).toBe(true);
  });

  it('flags it even with no drafter available at all (detection is mandatory, drafting optional)', async () => {
    baseForm();
    const q = geminiField();

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: {},
    });

    expect(q.value).toBe('');
    expect(result.skipped_reasons.some((r) => /required open-ended question left blank/.test(r))).toBe(true);
  });

  it('never drafts a whole-sentence answer it cannot fit; leaves the field to the student', async () => {
    baseForm();
    const q = textInput('question_9');
    q.required = true;
    q.maxLength = 30; // no real sentence fits
    markReactManaged(q);
    wrapper(GEMINI_LABEL, q);
    const draftAnswer = vi.fn(async (_q: string) => 'This answer cannot possibly be trimmed to thirty characters as a whole sentence.');

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: {},
      draftAnswer,
    });

    expect(q.value).toBe(''); // a mid-clause clip misrepresents her; blank + flag instead
    expect(result.skipped_reasons.some((r) => /required open-ended question left blank/.test(r))).toBe(true);
  });

  it('the always-ask holds still beat drafting: salary is never drafted', async () => {
    baseForm();
    const q = textInput('question_55');
    q.required = true;
    markReactManaged(q);
    wrapper('What are your salary expectations for this role? Please share a specific figure.*', q);
    const draftAnswer = vi.fn(async (_q: string) => 'should never be called for this');

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: {}, // no stored salary: the field must stay an always-ask blank
      draftAnswer,
    });

    expect(draftAnswer).not.toHaveBeenCalled();
    expect(q.value).toBe('');
    expect(result.skipped_reasons.some((r) => /left blank|left for you/.test(r))).toBe(true);
  });

  it('the always-ask holds still beat drafting: work authorization is never drafted', async () => {
    baseForm();
    const q = textInput('question_56');
    q.required = true;
    markReactManaged(q);
    wrapper('Are you legally authorized to work in the United States?*', q);
    const draftAnswer = vi.fn(async (_q: string) => 'should never be called for this');

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: {},
      draftAnswer,
    });

    expect(draftAnswer).not.toHaveBeenCalled();
    expect(q.value).toBe('');
    expect(result.skipped_reasons.some((r) => /work-eligibility question left for you/.test(r))).toBe(true);
  });

  it('does NOT draft a short field-shaped label, required or not (no essays into name boxes)', async () => {
    baseForm();
    const q = textInput('question_77');
    q.required = true;
    markReactManaged(q);
    wrapper('Preferred first name*', q);
    const draftAnswer = vi.fn(async (_q: string) => 'should never be called for this');

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: {},
      draftAnswer,
    });

    expect(draftAnswer).not.toHaveBeenCalled();
    expect(q.value).toBe('');
    expect(result.skipped_reasons.some((r) => /required open-ended question left blank: "preferred first name/.test(r))).toBe(true);
  });

  it('textareas still reach the drafter exactly as before (no regression on the main path)', async () => {
    baseForm();
    const ta = document.createElement('textarea');
    markReactManaged(ta);
    wrapper('Why do you want to work at Cresta?*', ta);
    const draftAnswer = vi.fn(async (_q: string) => 'Because the problem is real. I want to build for support teams.');

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: {},
      draftAnswer,
    });

    expect(draftAnswer).toHaveBeenCalledTimes(1);
    expect(ta.value).toBe('Because the problem is real. I want to build for support teams.');
    expect(result.ai_drafted).toBe(1);
  });
});
