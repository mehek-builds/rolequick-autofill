// Client-side retry policy for a transient model-capacity failure (R-003, live QA 2026-07-16).
//
// Lives in lib/ rather than in background.ts for the same reason autosubmit-gate.ts does: it is
// pure decision logic with a real failure mode, and background.ts cannot be imported by a test
// (it pulls in chrome.* and defineBackground at module load).
//
// Why the retry is the CLIENT's job at all: the backend cannot retry its way out of an overload.
// Vercel kills /resume/generate at 60s (vercel.json maxDuration) and the observed incident needed
// ~6 attempts over ~2.5 minutes to get a 200. Only a fresh request escapes that ceiling. The
// backend's job is to say which failures are worth coming back for (503 + code 'llm_overloaded');
// this module decides how long to wait before doing so.

// Covers the observed incident: the manual poll that eventually got a 200 took ~2.5 min.
export const RESUME_OVERLOAD_BUDGET_MS = 150000;
const DEFAULT_WAIT_MS = 5000;
const MAX_WAIT_MS = 15000;
const MAX_JITTER_MS = 400;

// How long to wait before the next attempt. Honors the server's retry_after_ms hint when it sends a
// usable one, falling back to a fixed base otherwise.
//
// Clamped, because a server hint is advice and not a budget: obeying a large retry_after_ms
// literally would spend the entire 150s window in one sleep, turning "retry ~6 times over 2.5 min"
// (which is what recovered the live incident) into "retry once and give up".
//
// Jittered, because every Litos client retrying a SHARED incident is the actual failure mode:
// identical schedules synchronize into a thundering herd against an API that is already shedding
// load. Large prompts are shed first during an overload and resume-gen sends the JD plus the whole
// experience bank, so a synchronized fleet would be hammering the API with exactly the requests it
// is least able to serve.
export function overloadWaitMs(retryAfterMs: unknown, rand: () => number = Math.random): number {
  const hinted =
    typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : DEFAULT_WAIT_MS;
  return Math.min(hinted, MAX_WAIT_MS) + Math.floor(rand() * MAX_JITTER_MS);
}

// Is there enough of the budget left to be worth another attempt? Kept here beside the budget it
// reads so the two cannot drift apart.
export function overloadBudgetRemains(deadlineMs: number, now = Date.now()): boolean {
  return now < deadlineMs;
}
