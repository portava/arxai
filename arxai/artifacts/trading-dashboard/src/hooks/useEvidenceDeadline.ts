import { useEffect, useReducer } from "react";

/** Recheck evidence at its expiry, without a render or network poll every second. */
export function useEvidenceDeadline(deadlineMs: number | null): number {
  const [, recheck] = useReducer((version: number) => version + 1, 0);
  useEffect(() => {
    if (deadlineMs == null || !Number.isFinite(deadlineMs)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      const remaining = deadlineMs - Date.now();
      if (remaining > 0) {
        // Browsers clamp larger delays to 1ms; long timeframe evidence must not spin.
        timer = setTimeout(() => { recheck(); schedule(); }, Math.min(remaining, 2_147_483_647));
      }
    };
    const resume = () => { recheck(); schedule(); };
    const onVisibility = () => { if (document.visibilityState === "visible") resume(); };
    schedule();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [deadlineMs]);
  return Date.now();
}
