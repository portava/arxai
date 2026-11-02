/** One running read and at most one trailing refresh, regardless of trigger. */
export function createCoalescedTask(
  task: () => Promise<void>,
  minGapMs: number,
  onError: (error: unknown) => void,
): { request: () => void; stop: () => void } {
  let stopped = false;
  let running = false;
  let pending = false;
  let lastStarted = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule(): void {
    if (stopped || running || timer || !pending) return;
    const delay = minGapMs - (performance.now() - lastStarted);
    if (delay > 0) {
      timer = setTimeout(() => { timer = undefined; schedule(); }, delay);
      timer.unref();
      return;
    }
    pending = false;
    running = true;
    lastStarted = performance.now();
    void Promise.resolve().then(() => stopped ? undefined : task()).catch((error: unknown) => {
      try { onError(error); } catch { /* diagnostics must not break scheduling */ }
    }).finally(() => { running = false; schedule(); });
  }

  return {
    request() { if (!stopped) { pending = true; schedule(); } },
    stop() { stopped = true; pending = false; clearTimeout(timer); timer = undefined; },
  };
}
