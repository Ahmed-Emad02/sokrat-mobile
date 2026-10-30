/** One account-scoped registration at a time, with bounded retry backoff. */
export function createRegistrationRetry() {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let attempt: (() => Promise<boolean>) | null = null;
  let delay = 5_000;
  let settled: Array<() => void> = [];

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const run = async () => {
    if (running || !attempt) return;
    const version = generation;
    const task = attempt;
    running = true;
    let registered = false;
    try {
      registered = await task();
    } catch {
      // The caller logs a sanitized reason; never log credentials here.
    } finally {
      running = false;
      const callbacks = settled;
      settled = [];
      callbacks.forEach((resolve) => resolve());
    }
    if (version !== generation) {
      // A replacement account/token waits for the old request to settle.
      void run();
      return;
    }
    if (registered) {
      delay = 5_000;
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delay);
    delay = Math.min(delay * 2, 60_000);
  };

  return {
    start(task: () => Promise<boolean>) {
      generation += 1;
      clearTimer();
      delay = 5_000;
      attempt = task;
      void run();
    },
    stop() {
      generation += 1;
      clearTimer();
      attempt = null;
      return running
        ? new Promise<void>((resolve) => settled.push(resolve))
        : Promise.resolve();
    },
  };
}
