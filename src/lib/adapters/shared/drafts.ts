export const DEFAULT_DRAFT_CONCURRENCY = 3;

export interface DraftQueueOptions<T> {
  items: readonly T[];
  draftAnswer: (question: string) => Promise<string | null>;
  promptFor: (item: T) => string;
  onSettled: (item: T, draft: string | null) => void | Promise<void>;
  onProgress?: (pending: number) => void;
  concurrency?: number;
}

// Application forms can contain several independent essay questions. Running every request at
// once creates an unbounded burst against the drafting endpoint, while running them serially makes
// a normal form unnecessarily slow. A small worker pool keeps the burst bounded and still streams
// each answer into the adapter as soon as it resolves.
export async function runDraftQueue<T>({
  items,
  draftAnswer,
  promptFor,
  onSettled,
  onProgress,
  concurrency = DEFAULT_DRAFT_CONCURRENCY,
}: DraftQueueOptions<T>): Promise<void> {
  if (items.length === 0) return;

  const requestedConcurrency = Number.isFinite(concurrency)
    ? Math.max(1, Math.floor(concurrency))
    : DEFAULT_DRAFT_CONCURRENCY;
  const workerCount = Math.min(items.length, requestedConcurrency);
  let nextIndex = 0;
  let pending = items.length;

  onProgress?.(pending);

  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const item = items[nextIndex++];
      let draft: string | null = null;

      try {
        draft = (await draftAnswer(promptFor(item)))?.trim() || null;
      } catch {
        // A failed draft is recoverable. The adapter reports the field as left for the student.
      }

      try {
        await onSettled(item, draft);
      } finally {
        pending--;
        onProgress?.(pending);
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
}
