// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { verifyFieldPersists, isReactManagedNode, fillField } from './shared/dom';

// R-032's primitive: a write is only trusted once it demonstrably persists. These tests run the
// verifier against stand-ins for the three worlds it must tell apart - a plain server-rendered
// form, a React board whose hydration wipes the pre-hydration write, and a widget that fights
// every write. Delays are injected short so the suite stays fast; the schedule's SHAPE (widening
// checks, bounded refills) is what production uses, not its absolute timings.

const fast = { delaysMs: [15, 15, 15, 15, 15], maxRefills: 3 };

function plainInput(): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'text';
  document.body.appendChild(el);
  return el;
}

// Simulate React adopting a node: the fiber expando appears, and (for the revert case) the
// component's empty state replaces whatever sat in the pre-hydration DOM. After hydration the
// input behaves like a controlled component that ACCEPTS edits (R-007's closure: setNativeValue
// plus input/change is exactly what a mounted controlled input commits).
function hydrate(el: HTMLInputElement, wipeTo = ''): void {
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  nativeSet.call(el, wipeTo);
  (el as unknown as Record<string, unknown>)['__reactFiber$test'] = {};
}

describe('isReactManagedNode', () => {
  it('is false for server-rendered DOM and true once the framework attaches', () => {
    const el = plainInput();
    expect(isReactManagedNode(el)).toBe(false);
    hydrate(el);
    expect(isReactManagedNode(el)).toBe(true);
  });
});

describe('verifyFieldPersists', () => {
  it('passes quickly on a plain form where the value just sits still', async () => {
    const el = plainInput();
    await fillField(el, 'Mehek');
    expect(await verifyFieldPersists(el, 'Mehek', fast)).toBe(true);
    expect(el.value).toBe('Mehek');
  });

  it('re-fills after a hydration wipe and verifies against the mounted component (the R-032 case)', async () => {
    const el = plainInput();
    await fillField(el, 'Mehek'); // pre-hydration write, exactly what the live bug did
    setTimeout(() => hydrate(el), 20); // hydration lands mid-verification and wipes the DOM
    expect(await verifyFieldPersists(el, 'Mehek', { ...fast, expectHydration: true })).toBe(true);
    // The whole point: the field really holds the value afterwards, not just the count.
    expect(el.value).toBe('Mehek');
    expect(isReactManagedNode(el)).toBe(true);
  });

  it('with expectHydration, stillness alone is not trusted until the window closes', async () => {
    // Pre-hydration a value "sits still" right up until hydration wipes it, so the early
    // stability exit must be off. Hydration here lands LATE (after 3 quiet checks would have
    // passed); the verifier must still be watching, catch the wipe, and re-fill.
    const el = plainInput();
    await fillField(el, 'Mehek');
    setTimeout(() => hydrate(el), 55);
    expect(await verifyFieldPersists(el, 'Mehek', { ...fast, expectHydration: true })).toBe(true);
    expect(el.value).toBe('Mehek');
  });

  it('reports false, bounded, when the page clears every write', async () => {
    const el = plainInput();
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    let wipes = 0;
    // A hostile stand-in: whatever is written is asynchronously cleared, forever.
    el.addEventListener('input', () => {
      setTimeout(() => { nativeSet.call(el, ''); wipes++; }, 5);
    });
    await fillField(el, 'Mehek');
    expect(await verifyFieldPersists(el, 'Mehek', fast)).toBe(false);
    // Bounded: initial write + at most maxRefills re-fills, not an unbounded fight.
    expect(wipes).toBeLessThanOrEqual(1 + fast.maxRefills);
  });

  it('never overwrites a different non-empty value (the student may be typing)', async () => {
    const el = plainInput();
    await fillField(el, 'Mehek');
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    nativeSet.call(el, 'Meh'); // someone edited the box mid-verification
    expect(await verifyFieldPersists(el, 'Mehek', fast)).toBe(false);
    // Hands off: the verifier flags, it does not fight.
    expect(el.value).toBe('Meh');
  });

  it('treats a re-spaced tel value as persisted, and re-arranged digits as not', async () => {
    const el = plainInput();
    el.type = 'tel';
    await fillField(el, '567417451');
    const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    // A widget re-spacing the same digits is cosmetic, not a revert.
    nativeSet.call(el, '56 741 7451');
    expect(await verifyFieldPersists(el, '567417451', fast)).toBe(true);
    // intl-tel-input's trunk-zero rewrite changes the digits: that IS the mangle, flag it.
    const el2 = plainInput();
    el2.type = 'tel';
    await fillField(el2, '567417451');
    nativeSet.call(el2, '0567417451');
    expect(await verifyFieldPersists(el2, '567417451', fast)).toBe(false);
  });

  it('exits immediately once a framework-managed node holds the value', async () => {
    const el = plainInput();
    hydrate(el); // already mounted before the fill, the common post-hydration case
    await fillField(el, 'Mehek');
    const start = Date.now();
    expect(await verifyFieldPersists(el, 'Mehek', { ...fast, expectHydration: true })).toBe(true);
    // One check (~15ms injected), not the whole window: the signal is detection, not sleeping.
    expect(Date.now() - start).toBeLessThan(60);
  });
});
