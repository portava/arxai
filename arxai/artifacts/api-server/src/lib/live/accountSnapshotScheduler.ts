/** One serialized reader for initial, event-driven and fallback account updates.
 * Events during a read earn one trailing read, never a parallel read that can
 * finish out of order. This only schedules existing scoped reads; it neither
 * settles trades nor changes balance/permission evidence.
 */
export function createAccountSnapshotScheduler(
  read: () => Promise<void>,
  options: {
    minGapMs?: number;
    now?: () => number;
    schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
    cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  } = {},
) {
  const minGapMs = options.minGapMs ?? 250;
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  let stopped = false;
  let running = false;
  let pending = false;
  let lastStart: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const drain = () => {
    if (stopped || running || timer != null || !pending) return;
    const elapsed = lastStart == null ? minGapMs : Math.max(0, now() - lastStart);
    if (elapsed < minGapMs) {
      timer = schedule(() => { timer = null; drain(); }, minGapMs - elapsed);
      return;
    }
    pending = false;
    running = true;
    lastStart = now();
    void (async () => {
      try { await read(); }
      catch { /* The route reports safe errors; a failed read must not wedge scheduling. */ }
      finally { running = false; drain(); }
    })();
  };

  return {
    request() { if (!stopped) { pending = true; drain(); } },
    stop() {
      stopped = true;
      pending = false;
      if (timer != null) cancel(timer);
      timer = null;
    },
  };
}
