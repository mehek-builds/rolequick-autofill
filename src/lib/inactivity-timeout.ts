export function withInactivityTimeout<T>(
  operation: (heartbeat: () => void, signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const controller = new AbortController();

    const heartbeat = (): void => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        settled = true;
        controller.abort();
        reject(new Error('timed out'));
      }, timeoutMs);
    };

    heartbeat();
    Promise.resolve()
      .then(() => operation(heartbeat, controller.signal))
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}
