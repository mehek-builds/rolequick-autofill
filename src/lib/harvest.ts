import { classifyField, isRefusedQuestion, type ProfileKey } from './adapters/generic';

/* Harvest: learn the student's profile from the ONE application they fill by hand.
 *
 * The bargain, and it is the whole product: fill one real application yourself, and never type
 * any of it again. RoleQuick watches that form, keeps what a form can legitimately teach it, and
 * stops the moment onboarding completes.
 *
 * Three properties this file exists to guarantee:
 *
 *  1. WE ONLY LEARN WHAT THE STUDENT TYPED. Every listener checks `e.isTrusted`, which is false
 *     for events RoleQuick's own fills dispatch. Without it, harvest would "learn" the values it
 *     just wrote and launder its own guesses into the profile as though the student had confirmed
 *     them. This check is not an optimisation; it is the difference between observing and
 *     fabricating. (content.ts:939 already relies on the same property to cancel auto-submit only
 *     on real edits.)
 *
 *  2. WE NEVER LEARN WORK AUTHORIZATION, SPONSORSHIP, OR SELF-ID. Not by policy here but by
 *     construction: harvest is driven entirely by ProfileKey, which has no member for any of
 *     them, and classifyField refuses those questions before it maps anything. The server refuses
 *     them again with a hard 400. R-004 put a false legal declaration on a real application by
 *     deriving a location-scoped answer from a global flag; capturing one and replaying it is the
 *     same bug pointed the other way.
 *
 *  3. WE NEVER OVERWRITE. The server only fills fields that are currently empty, so a value the
 *     student typed in Settings always wins over one we watched them type into someone's form.
 */

// Long enough that we are not posting on every keystroke, short enough that a 12-minute form has
// long since flushed by the time they hit submit (pagehide is best-effort; sendMessage during
// unload frequently does not survive, so idle-flushing is the reliable path, not the fallback).
const FLUSH_IDLE_MS = 2000;

// A form value that looks like an essay is not a profile field, whatever its label said.
const MAX_VALUE_LEN = 300;

type Buffer = Partial<Record<ProfileKey, string>>;

let buffer: Buffer = {};
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
// Set once the backend says onboarding is over. Harvest never restarts in this page's lifetime.
let stopped = false;

function isOurNode(t: EventTarget | null): boolean {
  return t instanceof Element && !!t.closest('[id*="rolequick"]');
}

/**
 * The value a human would say this control currently holds.
 *
 * Deliberately NOT `.value` for selects and comboboxes: a <select> value is often a code ("AE")
 * while the option text is the answer ("United Arab Emirates"), and a react-select keeps `.value`
 * empty even after a real selection - the selection lives in component state, which is why
 * content.ts's required-field check reads the rendered value node instead. Storing "AE" or ""
 * would be worse than storing nothing.
 */
export function readControlValue(el: Element): string | null {
  const tag = el.tagName.toLowerCase();

  if (tag === 'select') {
    const sel = el as HTMLSelectElement;
    const text = sel.selectedOptions?.[0]?.text ?? '';
    // A placeholder option ("Select...", "-- Choose --") is not an answer.
    if (!text.trim() || /^\s*(-{2,}|select|choose|please select)/i.test(text)) return null;
    return text.trim();
  }

  if (tag === 'textarea') return (el as HTMLTextAreaElement).value.trim() || null;

  if (tag === 'input') {
    const inp = el as HTMLInputElement;
    // Never read a control the student cannot see, and never read files/passwords.
    if (['password', 'file', 'hidden'].includes(inp.type)) return null;
    // Radios and checkboxes are out of scope for v1 - see collect() for why.
    if (inp.type === 'radio' || inp.type === 'checkbox') return null;

    // react-select renders a visible input whose .value stays empty after a selection.
    const control = inp.closest('[class*="select__control"], [class*="Select-control"]');
    if (control) {
      const valueNode = control.querySelector(
        '[class*="single-value"], [class*="singleValue"], [class*="Select-value-label"]',
      );
      return valueNode?.textContent?.trim() || null;
    }
    return inp.value.trim() || null;
  }

  return null;
}

/**
 * Which profile field is this control about, if any? Null for anything we must not learn.
 *
 * Reads BOTH the control's own identity and its surrounding question stem, mirroring
 * generic.ts's fill path, which tests both for the same reason: a work-auth question rendered as
 * a textarea only reveals itself through the stem, and missing it there is exactly how R-004
 * reached a live form.
 *
 * REFUSAL WINS OVER RECOGNITION, from either reading. That asymmetry is the point. "Are you
 * authorized to work in the LOCATION where this role is based?" classifies as address_city on a
 * naive read of the words, so a control that maps cleanly is still dropped when either reading
 * names a refused question. False negatives cost a re-typed field; false positives cost a false
 * legal declaration.
 */
export function keyFor(el: Element): ProfileKey | null {
  const type = el.getAttribute('type') ?? undefined;
  const own = readIdentity(el);
  const question = readQuestion(el);

  if (isRefusedQuestion(own) || isRefusedQuestion(question)) return null;

  return classifyField(own, type) ?? classifyField(question, type);
}

/* Local re-implementations of controlIdentity/questionLabel's reading, kept tiny and read-only.
   generic.ts keeps its versions module-private, and widening their export surface to serve
   harvest would put fill's DOM plumbing on a public API for one consumer. */
// CSS.escape is universal in Chrome but absent in some non-browser DOM implementations, and a
// missing global here would throw inside an input listener on a real job application - taking
// harvest down mid-form for a selector fallback we barely need.
function escapeId(id: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(id)
    : id.replace(/["\\]/g, '\\$&');
}

function readIdentity(el: Element): string {
  const parts: string[] = [];
  const withLabels = el as HTMLInputElement;
  const label =
    (withLabels.labels && withLabels.labels[0]?.textContent) ||
    (el.id ? document.querySelector(`label[for="${escapeId(el.id)}"]`)?.textContent : '') ||
    '';
  parts.push(label ?? '');
  parts.push(el.getAttribute('aria-label') ?? '');
  parts.push(el.getAttribute('placeholder') ?? '');
  parts.push(el.getAttribute('name') ?? '');
  parts.push(el.id ?? '');
  return parts.join(' ').replace(/[​‌‍﻿ ]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function readQuestion(el: Element): string {
  const fieldset = el.closest('fieldset');
  const legend = fieldset?.querySelector('legend')?.textContent;
  if (legend?.trim()) return legend.trim().toLowerCase();
  const block = el.closest('div, section, li');
  const text = block?.querySelector('label, legend, .question, h3, h4')?.textContent ?? '';
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function collect(el: Element): void {
  if (stopped) return;
  // Radios and checkboxes are deliberately not harvested in v1. Classifying one means reading the
  // GROUP's question (the stem lives in an ancestor above the options, never in the option's own
  // label), which is the most fragile DOM read in the codebase. The cost of skipping them is
  // near zero: the harvestable fields render as text inputs or selects, and the questions that
  // DO render as radios are overwhelmingly work-auth, sponsorship and EEO - every one of which
  // is denied anyway.
  const key = keyFor(el);
  if (!key) return;
  const value = readControlValue(el);
  if (!value || value.length > MAX_VALUE_LEN) return;
  buffer[key] = value;
  schedule();
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, FLUSH_IDLE_MS);
}

async function flush(): Promise<void> {
  timer = null;
  if (stopped) return;
  const fields = buffer;
  if (Object.keys(fields).length === 0) return;
  // Clear before the await: a slow round-trip must not swallow what they typed meanwhile.
  buffer = {};
  try {
    const res = await chrome.runtime.sendMessage({ type: 'HARVEST_FIELDS', fields });
    // The backend is the authority on whether harvest is still allowed. 403 = onboarding is
    // finished, so stop for good rather than posting into a wall on every keystroke.
    if (res?.stop) {
      stopped = true;
      buffer = {};
    }
  } catch {
    // The service worker can be asleep or the tab mid-teardown. Losing a field is fine: the
    // student is still on the form, and the next edit re-buffers. Never surface this - a toast
    // about a background write would be noise on top of a job application.
  }
}

/**
 * The listener body, exported so the isTrusted guard can be tested against a real call rather
 * than a mock. jsdom defines Event.isTrusted as a non-configurable own property in the Event
 * constructor, so a synthetic trusted event cannot be minted - dispatching in a test can only
 * ever produce isTrusted=false, which would make "untrusted events are ignored" pass even if the
 * listener were never wired up at all. Taking an Event-shaped argument keeps the guard itself
 * under test, both directions.
 */
export function handleInput(e: Pick<Event, 'isTrusted' | 'target'>): void {
  if (!e.isTrusted) return; // <- the whole safety model. See (1) above.
  if (isOurNode(e.target)) return;
  if (e.target instanceof Element) collect(e.target);
}

/** Start watching this page. Idempotent: SPA re-inits must not stack listeners. */
export function startHarvest(): void {
  if (started) return;
  started = true;

  const onInput = (e: Event) => handleInput(e);

  // Capture phase: a page that stops propagation on its own inputs must not blind us.
  document.addEventListener('input', onInput, true);
  // react-select and native <select> commit on change, not input.
  document.addEventListener('change', onInput, true);
  // Best-effort only; sendMessage rarely survives unload, which is why idle-flush is the
  // primary path rather than the backstop.
  window.addEventListener('pagehide', () => void flush());
}

/** Test seam. */
export function __resetHarvest(): void {
  buffer = {};
  started = false;
  stopped = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
