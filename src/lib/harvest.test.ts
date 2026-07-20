// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readControlValue, keyFor, handleInput, __resetHarvest } from './harvest';

/* Harvest reads real ATS DOM, so these tests build real ATS DOM. The shapes below are the ones
 * that actually shipped bugs: a <select> whose value is a country CODE, a react-select whose
 * .value stays empty after a selection, and a work-auth question whose stem lives in an ancestor
 * above the input.
 */

function mount(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('readControlValue', () => {
  it('reads a text input', () => {
    mount('<input id="a" value="+971 50 123 4567">');
    expect(readControlValue(document.getElementById('a')!)).toBe('+971 50 123 4567');
  });

  it('reads a select by OPTION TEXT, not its value', () => {
    // A country <select> is routinely value="AE" text="United Arab Emirates". Storing "AE" would
    // be worse than storing nothing: it is not what the student said, and it will not match the
    // next form's option list.
    mount('<select id="c"><option value="">Select...</option><option value="AE" selected>United Arab Emirates</option></select>');
    expect(readControlValue(document.getElementById('c')!)).toBe('United Arab Emirates');
  });

  it('treats an unselected placeholder option as no answer', () => {
    mount('<select id="c"><option value="" selected>Select...</option><option value="AE">United Arab Emirates</option></select>');
    expect(readControlValue(document.getElementById('c')!)).toBeNull();
  });

  it('reads a react-select from its rendered value node, not .value', () => {
    // The exact shape content.ts's required-field check already works around: .value stays empty
    // after a real selection because the selection lives in component state.
    mount(`
      <div class="select__control">
        <div class="select__single-value">India</div>
        <input id="rs" role="combobox" value="">
      </div>`);
    expect(readControlValue(document.getElementById('rs')!)).toBe('India');
  });

  it('returns null for an EMPTY react-select rather than its empty .value', () => {
    mount(`
      <div class="select__control">
        <div class="select__placeholder">Select...</div>
        <input id="rs" role="combobox" value="">
      </div>`);
    expect(readControlValue(document.getElementById('rs')!)).toBeNull();
  });

  it('never reads a password, file, or hidden input', () => {
    mount('<input id="p" type="password" value="hunter2"><input id="h" type="hidden" value="x">');
    expect(readControlValue(document.getElementById('p')!)).toBeNull();
    expect(readControlValue(document.getElementById('h')!)).toBeNull();
  });

  it('does not read radios or checkboxes (out of scope for v1)', () => {
    mount('<input id="r" type="radio" checked><input id="cb" type="checkbox" checked>');
    expect(readControlValue(document.getElementById('r')!)).toBeNull();
    expect(readControlValue(document.getElementById('cb')!)).toBeNull();
  });

  it('reads a textarea, and treats whitespace as empty', () => {
    mount('<textarea id="t">  Dubai </textarea><textarea id="e">   </textarea>');
    expect(readControlValue(document.getElementById('t')!)).toBe('Dubai');
    expect(readControlValue(document.getElementById('e')!)).toBeNull();
  });
});

describe('keyFor', () => {
  it('classifies a labelled input', () => {
    mount('<label for="p">Phone number</label><input id="p">');
    expect(keyFor(document.getElementById('p')!)).toBe('phone');
  });

  it('classifies from a placeholder or name when there is no label', () => {
    mount('<input id="l" name="linkedin_url">');
    expect(keyFor(document.getElementById('l')!)).toBe('linkedin_url');
  });

  it('uses the input type when the label says nothing', () => {
    mount('<input id="t" type="tel">');
    expect(keyFor(document.getElementById('t')!)).toBe('phone');
  });

  // ---- R-004. The reason refusal has to win over recognition. ----

  it('REFUSES a work-auth question whose stem lives in an ancestor, not the label', () => {
    // Real ATS shape: the question sits above the control. Reading only the control's own
    // identity would see "Location" and learn the student's city into a legal question.
    mount(`
      <fieldset>
        <legend>Are you legally authorized to work in the location where this role is based?</legend>
        <input id="wa">
      </fieldset>`);
    expect(keyFor(document.getElementById('wa')!)).toBeNull();
  });

  it('REFUSES a work-auth question that mentions a country', () => {
    mount(`
      <fieldset>
        <legend>Are you authorized to work in the country where this role is based?</legend>
        <input id="wa">
      </fieldset>`);
    expect(keyFor(document.getElementById('wa')!)).toBeNull();
  });

  it('REFUSES when the CONTROL looks innocent but the stem is a sponsorship question', () => {
    // Refusal from either reading. This is the asymmetry: a false negative costs a re-typed
    // field, a false positive costs a false legal declaration.
    mount(`
      <fieldset>
        <legend>Will you now or in the future require visa sponsorship?</legend>
        <input id="s" name="country">
      </fieldset>`);
    expect(keyFor(document.getElementById('s')!)).toBeNull();
  });

  it('REFUSES self-identification', () => {
    mount('<label for="g">What is your gender?</label><select id="g"><option selected>Female</option></select>');
    expect(keyFor(document.getElementById('g')!)).toBeNull();
  });

  it('REFUSES an SSN field', () => {
    mount('<label for="s">Social Security Number</label><input id="s">');
    expect(keyFor(document.getElementById('s')!)).toBeNull();
  });

  // ---- the distinction the product depends on ----

  it('LEARNS nationality while REFUSING the permit question beside it', () => {
    // ANYbotics/Lever, live 2026-07-16: nationality filled "India" correctly while the separate
    // permit question was left blank. Harvest must draw the same line.
    mount(`
      <div><label for="n">Nationality</label><input id="n" value="India"></div>
      <div><label for="w">Do you have a valid permit to work in Switzerland?</label><input id="w" value="No"></div>`);
    expect(keyFor(document.getElementById('n')!)).toBe('citizenship');
    expect(keyFor(document.getElementById('w')!)).toBeNull();
  });

  it('learns residence country and citizenship as different fields', () => {
    mount(`
      <div><label for="a">Country of citizenship</label><input id="a"></div>
      <div><label for="b">Which country are you based in?</label><input id="b"></div>`);
    expect(keyFor(document.getElementById('a')!)).toBe('citizenship');
    expect(keyFor(document.getElementById('b')!)).toBe('address_country');
  });

  it('returns null for an essay', () => {
    mount('<label for="e">Why do you want to work here?</label><textarea id="e"></textarea>');
    expect(keyFor(document.getElementById('e')!)).toBeNull();
  });
});

/* The safety property the whole design rests on.
 *
 * Litos's own fills dispatch synthetic input/change events (setNativeValue in shared/dom.ts
 * does exactly this, because React will not notice a value change otherwise). Those events carry
 * isTrusted=false. If harvest did not check it, Litos would observe the values it just wrote
 * and store them as though the student had confirmed them - laundering its own guesses into the
 * profile, and then replaying them onto every later application as fact.
 *
 * These drive handleInput directly rather than dispatching: jsdom defines isTrusted as a
 * non-configurable own property, so a dispatched event is ALWAYS untrusted and a
 * dispatch-based "we ignore untrusted events" test would pass even against a listener that was
 * never wired up. Calling the guard with both values is the only way to test it in both
 * directions.
 */
describe('handleInput: only learns what a human typed', () => {
  let sent: any[];

  function evt(el: Element, trusted: boolean) {
    return { isTrusted: trusted, target: el } as unknown as Event;
  }

  function type(el: Element, value: string, trusted: boolean) {
    (el as HTMLInputElement).value = value;
    handleInput(evt(el, trusted));
  }

  beforeEach(() => {
    __resetHarvest();
    vi.useFakeTimers();
    sent = [];
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: (msg: unknown) => {
          sent.push(msg);
          return Promise.resolve({ ok: true });
        },
      },
    };
  });

  it('learns a field the student typed (positive control - proves the pipeline is live)', async () => {
    mount('<label for="p">Phone number</label><input id="p">');
    type(document.getElementById('p')!, '+971 50 123 4567', true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([{ type: 'HARVEST_FIELDS', fields: { phone: '+971 50 123 4567' } }]);
  });

  it('IGNORES a programmatic fill - the same edit, untrusted, is not learned', async () => {
    // Byte-for-byte the test above with trusted=false. This is exactly what setNativeValue does
    // when Litos fills a field, so it is the real scenario rather than a contrived one.
    mount('<label for="p">Phone number</label><input id="p">');
    type(document.getElementById('p')!, '+1 555 000 0000', false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);
  });

  it("ignores edits inside Litos's own card", async () => {
    mount('<div id="rolequick-card-stack"><label for="q">Phone number</label><input id="q"></div>');
    type(document.getElementById('q')!, '+1 555 000 0000', true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);
  });

  it('never learns a refused field even when the student types it themselves', async () => {
    // A student answering a work-auth question by hand is the NORMAL case - Litos leaves it
    // blank for exactly that reason. Watching them answer it must still not store it.
    mount(`
      <fieldset>
        <legend>Are you legally authorized to work in the location where this role is based?</legend>
        <input id="wa">
      </fieldset>`);
    type(document.getElementById('wa')!, 'No, I need sponsorship', true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual([]);
  });

  it('batches a whole form into one post rather than one per keystroke', async () => {
    mount(`
      <div><label for="p">Phone number</label><input id="p"></div>
      <div><label for="c">City</label><input id="c"></div>
      <div><label for="n">Nationality</label><input id="n"></div>`);
    type(document.getElementById('p')!, '+971 50 123 4567', true);
    type(document.getElementById('c')!, 'Dubai', true);
    type(document.getElementById('n')!, 'India', true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: 'HARVEST_FIELDS',
      fields: { phone: '+971 50 123 4567', address_city: 'Dubai', citizenship: 'India' },
    });
  });

  it('stops for good when the backend says onboarding is complete', async () => {
    (globalThis as any).chrome.runtime.sendMessage = (msg: unknown) => {
      sent.push(msg);
      return Promise.resolve({ ok: false, stop: true });
    };
    mount('<div><label for="p">Phone number</label><input id="p"></div><div><label for="c">City</label><input id="c"></div>');
    type(document.getElementById('p')!, '+971 50 123 4567', true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(1);

    type(document.getElementById('c')!, 'Dubai', true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toHaveLength(1); // latched off
  });
});
