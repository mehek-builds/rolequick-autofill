import {
  classifySubmissionOutcome,
  resumeGenerationStatus,
  SUBMISSION_MONITOR_TIMEOUT_MS,
  type SubmissionOutcome,
} from './application-progress';

type TimerHandle = ReturnType<typeof setTimeout>;

export function createSubmissionOutcomeController(options: {
  readText: () => string;
  onOutcome: (outcome: Exclude<SubmissionOutcome, null>) => void;
  onUnknown: () => void;
  onStop: () => void;
  timeoutMs?: number;
  debounceMs?: number;
}) {
  let finished = false;
  let debounceTimer: TimerHandle | null = null;
  const teardown = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    clearTimeout(deadlineTimer);
    options.onStop();
  };
  const stop = () => {
    if (finished) return;
    finished = true;
    teardown();
  };
  const scan = (): boolean => {
    if (finished) return false;
    const outcome = classifySubmissionOutcome(options.readText());
    if (!outcome) return false;
    finished = true;
    teardown();
    options.onOutcome(outcome);
    return true;
  };
  const queueScan = () => {
    if (finished || debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      scan();
    }, options.debounceMs ?? 200);
  };
  const deadlineTimer = setTimeout(() => {
    if (finished) return;
    finished = true;
    teardown();
    options.onUnknown();
  }, options.timeoutMs ?? SUBMISSION_MONITOR_TIMEOUT_MS);

  return { scan, queueScan, stop, isFinished: () => finished };
}

export function createResumeGenerationController(options: {
  statusElement: HTMLElement | null;
  announcerElement: HTMLElement | null;
}) {
  let retryMessage: string | null = null;
  let lastAnnouncement = '';
  const announce = (message: string) => {
    if (!options.announcerElement || lastAnnouncement === message) return;
    lastAnnouncement = message;
    options.announcerElement.textContent = message;
  };
  const tick = (elapsedSeconds: number) => {
    const progress = resumeGenerationStatus(elapsedSeconds, retryMessage);
    if (options.statusElement) options.statusElement.textContent = progress;
    if (!retryMessage) announce(`${progress.replace(/ · \d+s$/, '')}.`);
  };
  const retry = (attempt: number) => {
    retryMessage = `The AI is busy right now. Retrying... (attempt ${attempt + 1})`;
    if (options.statusElement) options.statusElement.textContent = retryMessage;
    announce(`The resume service is busy. Retrying attempt ${attempt + 1}.`);
  };
  const finish = () => { retryMessage = null; };

  return { tick, retry, finish, announce };
}

export function createResumeReviewPrompt(options: {
  statusElement: HTMLElement;
  yesButton: HTMLButtonElement;
  noButton: HTMLButtonElement;
  summary: string;
  announce: (message: string) => void;
}): Promise<boolean> {
  options.statusElement.textContent = options.summary;
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;margin-top:10px;line-height:1.4;';
  const attach = document.createElement('button');
  attach.type = 'button';
  attach.textContent = 'Attach and fill';
  attach.style.cssText = 'flex:1;background:#4f46e5;color:white;border:none;border-radius:8px;padding:8px 6px;font-size:11px;font-weight:600;cursor:pointer;line-height:1.4;';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Not now';
  cancel.style.cssText = 'flex:1;background:#f3f4f6;color:#374151;border:none;border-radius:8px;padding:8px 6px;font-size:11px;font-weight:600;cursor:pointer;line-height:1.4;';
  actions.append(attach, cancel);
  options.statusElement.appendChild(actions);
  options.yesButton.style.display = 'none';
  options.noButton.style.display = 'none';
  options.announce('Resume review ready. Choose Attach and fill or Not now.');
  attach.focus();

  return new Promise<boolean>((resolve) => {
    attach.addEventListener('click', () => resolve(true), { once: true });
    cancel.addEventListener('click', () => resolve(false), { once: true });
  });
}

export function restoreResumeReviewControls(options: {
  statusElement: HTMLElement | null;
  yesButton: HTMLButtonElement | null;
  noButton: HTMLButtonElement | null;
}) {
  if (options.statusElement) {
    options.statusElement.textContent = 'Resume ready, but not attached. You can review the form or try again.';
  }
  if (options.yesButton) {
    options.yesButton.style.display = '';
    options.yesButton.disabled = false;
    options.yesButton.textContent = 'Review again';
  }
  if (options.noButton) options.noButton.style.display = '';
  options.yesButton?.focus();
}
