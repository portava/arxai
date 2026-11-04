/** Periodic maintenance: skip missed ticks rather than overlap or queue jobs. */
export function startIntervalWorker(task: () => Promise<void>, intervalMs: number, onError: (error: unknown) => void) {
  let active: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  function start() {
    if (timer) return;
    timer = setInterval(() => {
      if (active) return;
      active = Promise.resolve().then(task).catch((error: unknown) => {
        try { onError(error); } catch { /* reporting must not strand the lock */ }
      }).finally(() => { active = null; });
    }, intervalMs);
    timer.unref();
  }
  start();
  return {
    start,
    stop() { clearInterval(timer); timer = undefined; },
    async drain() { await active; },
  };
}
