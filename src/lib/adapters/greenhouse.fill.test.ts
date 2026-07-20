// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fillGreenhouseApplication } from './greenhouse';
import { skippedReasonsNeedReview } from '../autosubmit-gate';
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

describe('R-032 classic-form phone variant: the old intl-tel-input wrap (boards.greenhouse.io)', () => {
  // The Neuralink shape (R-032 update, 2026-07-18): the CLASSIC board wraps #phone in v12-era
  // intl-tel-input markup ("intl-tel-input" / "flag-container" / "selected-flag" / "iti-flag"
  // classes, none of the new board's "iti"/"iti__*" names) whose country UI is jQuery-bound <li>
  // elements, not a select or combobox. Pre-fix, the adapter saw neither widget nor selector,
  // typed the whole stored string, and the widget rewrote it to the local "056 741 7451" with
  // the country selector untouched.
  function classicItiPhone(): HTMLInputElement {
    const phone = textInput('phone', 'tel');
    markReactManaged(phone);
    const wrap = document.createElement('div');
    wrap.className = 'intl-tel-input allow-dropdown';
    const flagContainer = document.createElement('div');
    flagContainer.className = 'flag-container';
    const selectedFlag = document.createElement('div');
    selectedFlag.className = 'selected-flag';
    selectedFlag.title = 'United States: +1';
    const flag = document.createElement('div');
    flag.className = 'iti-flag us';
    selectedFlag.appendChild(flag);
    flagContainer.appendChild(selectedFlag);
    const list = document.createElement('ul');
    list.className = 'country-list hide';
    for (const [name, dial, cc] of [
      ['United States', '1', 'us'],
      ['United Arab Emirates', '971', 'ae'],
    ]) {
      const li = document.createElement('li');
      li.className = 'country';
      li.setAttribute('data-dial-code', dial);
      li.setAttribute('data-country-code', cc);
      li.textContent = `${name} +${dial}`;
      list.appendChild(li);
    }
    flagContainer.appendChild(list);
    wrap.appendChild(flagContainer);
    wrap.appendChild(phone);
    wrapper('Phone*', wrap);
    return phone;
  }

  function baseFormFields(): void {
    const { first, last, email } = coreFields();
    for (const el of [first, last, email]) markReactManaged(el);
  }

  it('writes E.164 into the classic widget box, so the code travels with the digits', async () => {
    baseFormFields();
    const phone = classicItiPhone();

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: ap,
    });

    // Never the spaced stored string (what the widget mangled) and never the bare national
    // number (the classic form submits the raw box value, so the code must ride in it).
    expect(phone.value).toBe('+971567417451');
    expect(result.fields_filled).toBe(4); // first, last, email, phone
    expect(result.skipped_reasons.filter((r) => /phone/.test(r))).toEqual([]);
  });

  it('un-counts and flags when the widget still rewrites the number to a local format', async () => {
    baseFormFields();
    const phone = classicItiPhone();
    // A widget that mangles despite the E.164 write: the verify pass's digits-only comparison
    // must catch the trunk-zero rewrite (a changed number, not a re-spacing) and tell the truth.
    phone.addEventListener('input', () => {
      setTimeout(() => nativeSet.call(phone, '056 741 7451'), 5);
    });

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: ap,
    });

    expect(result.fields_filled).toBe(3); // first, last, email; the phone write did not hold
    expect(result.skipped_reasons.some((r) => /phone left for you: the page did not keep/.test(r))).toBe(true);
  });

  it('still gets the selector + national treatment when a real country select is paired', async () => {
    baseFormFields();
    const phone = classicItiPhone();
    // A drivable paired control beats the E.164 fallback: same treatment as the new form.
    const select = document.createElement('select');
    select.id = 'country';
    for (const [value, text] of [
      ['US', 'United States (+1)'],
      ['AE', 'United Arab Emirates (+971)'],
    ]) {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      select.appendChild(o);
    }
    const w = phone.closest('.field-wrapper')!;
    w.insertBefore(select, phone.closest('.intl-tel-input'));

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: ap,
    });

    expect(select.value).toBe('AE');
    expect(phone.value).toBe('567417451');
    expect(result.fields_filled).toBe(4); // phone-as-one-field, selector included
  });

  it('keeps a number stored without a +prefix as-is, even inside the classic wrap', async () => {
    baseFormFields();
    const phone = classicItiPhone();

    await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: { phone: '0501234567' },
    });

    // No declared country means no safe split; never invent one (same rule as the new form).
    expect(phone.value).toBe('0501234567');
  });

  it('a plain classic phone box with no widget keeps the whole stored number (both directions)', async () => {
    baseFormFields();
    // Legacy name-based markup, no intl-tel-input anywhere: today's behavior, unchanged.
    const phone = document.createElement('input');
    phone.type = 'tel';
    phone.name = 'job_application[phone]';
    markReactManaged(phone);
    wrapper('Phone*', phone);

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: ap,
    });

    expect(phone.value).toBe('+971 567417451');
    expect(result.fields_filled).toBe(4);
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

describe('language questions (declared-list authority), through the real Greenhouse loop', () => {
  // The live ZURU phrasing, verbatim (2026-07-17). The whole preamble rides in the container
  // text, which is exactly what labelTextFor hands the classifier.
  const ZURU =
    'This role involves working closely with our team in Mexico, so Spanish language skills are ' +
    'preferred but not essential. Are you comfortable communicating in Spanish in a professional setting?';
  const declared = ['English', 'Hindi', 'Arabic', 'French'];

  function baseFormFields(): void {
    const { first, last, email } = coreFields();
    for (const el of [first, last, email]) markReactManaged(el);
  }

  function radioQuestion(labelText: string, name: string, options: string[]): Record<string, HTMLInputElement> {
    const w = document.createElement('div');
    w.className = 'field-wrapper';
    const label = document.createElement('label');
    label.textContent = labelText;
    w.appendChild(label);
    const els: Record<string, HTMLInputElement> = {};
    options.forEach((opt, i) => {
      const r = document.createElement('input');
      r.type = 'radio';
      r.name = name;
      r.id = `${name}_${i}`;
      const optionLabel = document.createElement('label');
      optionLabel.htmlFor = r.id;
      optionLabel.textContent = opt;
      w.appendChild(r);
      w.appendChild(optionLabel);
      els[opt] = r;
    });
    document.body.appendChild(w);
    return els;
  }

  function selectQuestion(labelText: string, options: string[]): HTMLSelectElement {
    const w = document.createElement('div');
    w.className = 'field-wrapper';
    const label = document.createElement('label');
    label.textContent = labelText;
    w.appendChild(label);
    const select = document.createElement('select');
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
    w.appendChild(select);
    document.body.appendChild(w);
    return select;
  }

  function run(languages?: string[], draftAnswer?: (q: string) => Promise<string | null>) {
    return fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: { languages } as ApplicationProfile,
      draftAnswer,
    });
  }

  it('ZURU radios, Spanish not declared: fills No, review-flagged, and the flag holds auto-submit', async () => {
    baseFormFields();
    const radios = radioQuestion(ZURU, 'zuru_spanish', ['Yes', 'No']);

    const result = await run(declared);

    expect(radios['No'].checked).toBe(true);
    expect(radios['Yes'].checked).toBe(false);
    expect(result.skipped_reasons.some((r) => /answered No \(spanish is not in your declared languages\)/.test(r))).toBe(true);
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  });

  it('ZURU radios, Spanish declared: a clean Yes with no language flag', async () => {
    baseFormFields();
    const radios = radioQuestion(ZURU, 'zuru_spanish', ['Yes', 'No']);

    const result = await run([...declared, 'Spanish']);

    expect(radios['Yes'].checked).toBe(true);
    expect(result.skipped_reasons.some((r) => /language|declared languages/.test(r))).toBe(false);
  });

  it('Enpal-style German level select, German not declared: lowest honest option + review flag', async () => {
    baseFormFields();
    const select = selectQuestion('Wie gut sind deine Deutschkenntnisse?', [
      'Keine Kenntnisse',
      'Grundkenntnisse',
      'Fließend',
      'Muttersprache',
    ]);

    const result = await run(declared);

    expect(select.value).toBe('Keine Kenntnisse');
    expect(result.skipped_reasons.some((r) => /picked the lowest german level.*review before submitting/.test(r))).toBe(true);
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  });

  it('English level select, English declared: the fluent tier, never Native', async () => {
    baseFormFields();
    const select = selectQuestion('English level', ['Basic', 'Conversational', 'Fluent', 'Native']);

    const result = await run(declared);

    expect(select.value).toBe('Fluent');
    expect(result.skipped_reasons.some((r) => /language|declared languages/.test(r))).toBe(false);
  });

  it('empty declared list: always-ask, nothing selected, and the reason holds auto-submit', async () => {
    baseFormFields();
    const radios = radioQuestion(ZURU, 'zuru_spanish', ['Yes', 'No']);

    const result = await run(undefined);

    expect(radios['Yes'].checked).toBe(false);
    expect(radios['No'].checked).toBe(false);
    expect(result.skipped_reasons.some((r) => /language question left for you \(no languages declared/.test(r))).toBe(true);
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  });

  it('a language question rendered as a required text input is flagged, never drafted (the R-033 gate is behind the language branch)', async () => {
    // ZURU's label ends in a question mark and is over 40 chars, so isOpenEndedQuestion fires on
    // it: without the language branch terminating the block, the R-033 gate would draft a prose
    // claim about her Spanish. It must flag instead.
    baseFormFields();
    const q = textInput('question_lang');
    q.required = true;
    markReactManaged(q);
    wrapper(ZURU, q);
    const draftAnswer = vi.fn(async (_q: string) => 'should never be called for a language question');

    const result = await run(declared, draftAnswer);

    expect(draftAnswer).not.toHaveBeenCalled();
    expect(q.value).toBe('');
    expect(result.skipped_reasons.some((r) => /language question left for you/.test(r))).toBe(true);
  });
});

describe('R-033 drafter gate: generic link asks are never drafted as prose (R-008 reopened)', () => {
  // The audit case: `share\b` fires isOpenEndedQuestion, no platform name for linkQuestion, no
  // profile key for classifyField - before the GENERIC_LINK_ASK veto, this REQUIRED URL-expecting
  // input received a drafted prose paragraph.
  const LINK_ASK_LABEL = "Share a link to something you've built*";

  function requiredInput(labelText: string): HTMLInputElement {
    const q = textInput('question_link');
    q.required = true;
    markReactManaged(q);
    wrapper(labelText, q);
    return q;
  }

  function baseFormFields(): void {
    const { first, last, email } = coreFields();
    for (const el of [first, last, email]) markReactManaged(el);
  }

  it('flags the link-ask input via linkSkipReason and never calls the drafter', async () => {
    baseFormFields();
    const q = requiredInput(LINK_ASK_LABEL);
    const draftAnswer = vi.fn(async (_q: string) => 'A prose paragraph that must never reach a URL field.');

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: {},
      draftAnswer,
    });

    expect(draftAnswer).not.toHaveBeenCalled();
    expect(q.value).toBe('');
    // linkSkipReason's wording, and it must hold auto-submit.
    expect(result.skipped_reasons.some((r) => /link question left for you/.test(r))).toBe(true);
    expect(skippedReasonsNeedReview(result.skipped_reasons)).toBe(true);
  });

  it('still drafts a genuine open-ended input that merely uses the same verb (both directions)', async () => {
    baseFormFields();
    const q = requiredInput('Please share what excites you about this role.*');
    q.maxLength = 255;
    const draftAnswer = vi.fn(async (_q: string) => 'The product is real and the team ships. I want to build that.');

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: {},
      draftAnswer,
    });

    expect(draftAnswer).toHaveBeenCalledTimes(1);
    expect(q.value).toBe('The product is real and the team ships. I want to build that.');
    expect(result.ai_drafted).toBe(1);
  });

  it('an OPTIONAL link-ask input is flagged with the link wording too, not the generic blank line', async () => {
    baseFormFields();
    const q = textInput('question_link_opt');
    markReactManaged(q);
    wrapper("Share a link to something you've built", q);

    const result = await fillGreenhouseApplication({
      fullName: 'Mehek Mandal',
      email: 'mehekman@usc.edu',
      profile,
      applicationProfile: {},
    });

    expect(q.value).toBe('');
    expect(result.skipped_reasons.some((r) => /link question left for you/.test(r))).toBe(true);
  });
});
