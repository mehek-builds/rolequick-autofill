// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { driveAsyncLocationCombobox, matchLocationOption } from './shared/dom';
import { locationComboQueries, locationQuestion, locationSkipReason } from './generic';
import type { ApplicationProfile } from '../types';

// R-002's second half. The classifier (generic.answers.test.ts) proves a location question is
// recognised and flagged; these tests prove the CALLER can actually drive Ashby's async picker to
// a committed value, which is what the live verdict on Espa Labs (2026-07-17) said was missing:
// the flag replaced the silent blank, but Location itself stayed empty while the profile held the
// value. The stand-in below mirrors the real widget's three measured behaviors: the listbox is
// populated by an async lookup that lands AFTER the last keystroke, a too-short query renders no
// listbox at all ("Dubai" alone returned nothing; "Dubai, United Arab Emirates" returned one
// option), and only a real click on an option commits anything - typed text alone leaves the form
// value empty no matter what the input visibly shows.

const ap = (o: Partial<ApplicationProfile> = {}): ApplicationProfile => o as ApplicationProfile;
const profile = ap({ address_city: 'Dubai', address_country: 'United Arab Emirates' });

const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
let widgetSeq = 0;

// The fake commits the way Ashby does: on click (and ONLY on click - a driver that merely
// dispatches mouse events without the element click, or none at all, commits nothing), the input
// settles to the option's text, the listbox empties, and aria-expanded flips to "false". The
// commit writes through the prototype setter WITHOUT dispatching input, the way a React re-render
// lands, so it cannot be confused with the driver's own typing.
function asyncLocationPicker(opts: {
  optionsFor: (query: string) => string[];
  latencyMs?: number;
  commitTo?: (optionText: string) => string;
  commitOnClick?: boolean;
}) {
  const listboxId = `rq-test-listbox-${++widgetSeq}`;
  const entry = document.createElement('div');
  entry.className = '_fieldEntry_t3st';
  const label = document.createElement('label');
  label.textContent = 'Location';
  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listboxId);
  const listbox = document.createElement('div');
  listbox.id = listboxId;
  listbox.setAttribute('role', 'listbox');
  entry.append(label, input, listbox);
  document.body.appendChild(entry);

  const typed: string[] = [];
  const clicked: string[] = [];
  let lookupTimer: ReturnType<typeof setTimeout> | undefined;

  input.addEventListener('input', () => {
    const q = input.value;
    if (q) typed.push(q);
    // A new keystroke abandons the in-flight lookup and empties the menu, like the real widget.
    clearTimeout(lookupTimer);
    listbox.textContent = '';
    input.setAttribute('aria-expanded', 'false');
    if (!q) return;
    lookupTimer = setTimeout(() => {
      const texts = opts.optionsFor(q);
      if (texts.length === 0) return;
      input.setAttribute('aria-expanded', 'true');
      for (const t of texts) {
        const o = document.createElement('div');
        o.setAttribute('role', 'option');
        o.textContent = t;
        // jsdom rects are all zeros and readRenderedOptions drops zero-size nodes, so the fake
        // options carry real-looking geometry.
        o.getBoundingClientRect = () =>
          ({ width: 200, height: 24, x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 24, toJSON: () => ({}) }) as DOMRect;
        o.addEventListener('click', () => {
          clicked.push(t);
          if (opts.commitOnClick === false) return;
          nativeSet.call(input, (opts.commitTo ?? ((x: string) => x))(t));
          listbox.textContent = '';
          input.setAttribute('aria-expanded', 'false');
        });
        listbox.appendChild(o);
      }
    }, opts.latencyMs ?? 120);
  });

  return { entry, input, typed, clicked };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('locationComboQueries', () => {
  it('builds the fuller query first, bare unit second, from stored values only', () => {
    expect(locationComboQueries('city', profile)).toEqual(['Dubai, United Arab Emirates', 'Dubai']);
    expect(locationComboQueries('country', profile)).toEqual(['United Arab Emirates']);
  });

  it('never fabricates: an unset unit yields no query at all', () => {
    // The whole R-002 family is "the profile HAS the value and the fill missed it". The inverse
    // must stay impossible: no stored city means nothing gets typed, and the caller's no-value
    // flag path is the only outcome.
    expect(locationComboQueries('city', ap({ address_country: 'United Arab Emirates' }))).toEqual([]);
    expect(locationComboQueries('country', ap({}))).toEqual([]);
    expect(locationComboQueries('state', ap({ address_city: 'Dubai' }))).toEqual([]);
  });

  it('collapses duplicate units instead of typing "Singapore, Singapore"', () => {
    expect(locationComboQueries('city', ap({ address_city: 'Singapore', address_country: 'Singapore' }))).toEqual([
      'Singapore',
    ]);
  });
});

describe('matchLocationOption', () => {
  const o = (...texts: string[]) => texts.map((text) => ({ text, el: document.createElement('div') }));

  it('accepts the Espa shape: the option is a unit INSIDE the typed query', () => {
    expect(matchLocationOption(o('United Arab Emirates'), 'Dubai, United Arab Emirates')?.text).toBe(
      'United Arab Emirates',
    );
  });

  it('accepts the places shape: the option CONTAINS the typed query, shortest wins', () => {
    const options = o('Dubai, Dubai, United Arab Emirates, Middle East', 'Dubai, United Arab Emirates');
    expect(matchLocationOption(options, 'Dubai, United Arab Emirates')?.text).toBe('Dubai, United Arab Emirates');
  });

  it('never matches an unrelated option, however plausible it looks', () => {
    // "United States" shares two words with the query. Clicking it anyway would file a wrong
    // residence on a real application, which is the mis-fill direction this whole feature must
    // never take: no match means no click.
    expect(matchLocationOption(o('United States', 'Berlin, Germany'), 'Dubai, United Arab Emirates')).toBeNull();
  });
});

describe('driveAsyncLocationCombobox', () => {
  it('types the FULLER query: the bare city renders no listbox on the real widget', async () => {
    // Measured on Espa: "Dubai" -> no listbox, ever; "Dubai, United Arab Emirates" -> one option.
    const w = asyncLocationPicker({
      optionsFor: (q) => (/dubai/i.test(q) && /united arab emirates/i.test(q) ? ['United Arab Emirates'] : []),
    });
    const got = await driveAsyncLocationCombobox(w.input, locationComboQueries('city', profile), w.entry);
    expect(w.typed[0]).toBe('Dubai, United Arab Emirates');
    expect(got).toBe('United Arab Emirates');
  });

  it('commits by clicking the option and verifies the read-back, not the typed text', async () => {
    const w = asyncLocationPicker({
      optionsFor: (q) => (/united arab emirates/i.test(q) ? ['United Arab Emirates'] : []),
    });
    const got = await driveAsyncLocationCombobox(w.input, locationComboQueries('city', profile), w.entry);
    expect(w.clicked).toEqual(['United Arab Emirates']);
    // The committed value is the OPTION's text, which is what the widget settled to - not the
    // query we happened to type. aria-expanded settling to "false" is part of the verified state.
    expect(w.input.value).toBe('United Arab Emirates');
    expect(w.input.getAttribute('aria-expanded')).toBe('false');
    expect(got).toBe('United Arab Emirates');
  });

  it('falls back to the bare unit for preloaded pickers that filter by containment', async () => {
    // A react-select with preloaded city options finds nothing CONTAINING the fuller string, so
    // the driver must retry with the bare stored unit - and still match against the fuller query.
    const w = asyncLocationPicker({
      optionsFor: (q) => ('dubai'.includes(q.trim().toLowerCase()) ? ['Dubai'] : []),
    });
    const got = await driveAsyncLocationCombobox(w.input, locationComboQueries('city', profile), w.entry);
    expect(w.typed).toEqual(['Dubai, United Arab Emirates', 'Dubai']);
    expect(got).toBe('Dubai');
  });

  it('no matching option: clicks nothing, clears the typed text, returns null for the flag path', async () => {
    // The lookup answers, but with the wrong geography. Filling it would be worse than the blank
    // R-002 started from, so the driver must refuse AND un-type its query - a filled-LOOKING
    // input whose form value is empty is the exact lie the register documents, and the card is
    // about to tell the student this field was left for her.
    const w = asyncLocationPicker({ optionsFor: () => ['United States'] });
    const got = await driveAsyncLocationCombobox(w.input, locationComboQueries('city', profile), w.entry, 800, 40);
    expect(got).toBeNull();
    expect(w.clicked).toEqual([]);
    expect(w.input.value).toBe('');
  });

  it('listbox never renders: bounded poll gives up, clears, returns null', async () => {
    const w = asyncLocationPicker({ optionsFor: () => [] });
    const got = await driveAsyncLocationCombobox(w.input, locationComboQueries('city', profile), w.entry, 500, 40);
    expect(got).toBeNull();
    expect(w.input.value).toBe('');
  });

  it('click that never commits fails verification instead of being claimed as a fill', async () => {
    // The direction nobody worries about, tested on purpose: the click LANDS but the widget
    // commits nothing (the menu stays open, the value never settles). Reporting "filled" here
    // would recreate R-002 with extra confidence, so the driver must read the control back, see
    // no committed value, and hand the caller the flag path.
    const w = asyncLocationPicker({
      optionsFor: (q) => (/united arab emirates/i.test(q) ? ['United Arab Emirates'] : []),
      commitOnClick: false,
    });
    const got = await driveAsyncLocationCombobox(w.input, locationComboQueries('city', profile), w.entry, 800, 40);
    expect(w.clicked).toEqual(['United Arab Emirates']);
    expect(got).toBeNull();
    expect(w.input.value).toBe('');
  });

  it('commit of an UNRELATED value is refused by the read-back check', async () => {
    // A hostile variant of the same direction: the widget commits, but not what was chosen.
    // The read-back must relate to the clicked option or the typed query, else the driver
    // refuses the fill rather than vouching for a value nobody asked for.
    const w = asyncLocationPicker({
      optionsFor: (q) => (/united arab emirates/i.test(q) ? ['United Arab Emirates'] : []),
      commitTo: () => 'Berlin, Germany',
    });
    const got = await driveAsyncLocationCombobox(w.input, locationComboQueries('city', profile), w.entry, 800, 40);
    expect(got).toBeNull();
    expect(w.input.value).toBe('');
  });
});

describe('the R-004 lock survives the driving work', () => {
  it('citizenship and nationality questions are refused before any query could be composed', () => {
    // The driver only ever runs downstream of locationQuestion, so these returning null means no
    // query is composed, nothing is typed, and no option can be clicked - residence can never
    // answer a citizenship question, no matter how drivable the widget is.
    expect(locationQuestion('what country are you a citizen of?', profile)).toBeNull();
    expect(locationQuestion('country of citizenship', profile)).toBeNull();
    expect(locationQuestion('nationality', profile)).toBeNull();
  });

  it('location-scoped work-eligibility questions are refused the same way', () => {
    expect(locationQuestion('which country are you authorized to work in?', profile)).toBeNull();
    expect(locationQuestion('are you legally authorized to work in canada?', profile)).toBeNull();
    expect(
      locationQuestion('do you require sponsorship to work in the country where this role is based?', profile),
    ).toBeNull();
  });

  it('the no-option fallback is the gate-holding flag, not a guess', () => {
    // "left for" is what the auto-submit gate's REVIEW_FLAG matches (locked separately in
    // autosubmit-gate.test.ts), so a failed drive holds the countdown rather than submitting an
    // empty required field.
    expect(locationSkipReason('city', 'Location', 'no-option')).toContain('left for you');
  });
});
