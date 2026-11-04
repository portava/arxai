import type { Response } from "express";

export const SSE_DRAIN_TIMEOUT_MS = 10_000;

/** Bound slow display streams instead of retaining an unbounded backlog.
 * Account/chart subscribers reconnect and obtain current snapshots. Never use
 * this lossy transport for order submission or broker execution evidence. */
export function createSseWriter(res: Response, cleanup: () => void) {
  let closed = false;
  let blocked = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  const drained = () => {
    blocked = false;
    clearTimeout(drainTimer);
    res.off("drain", drained);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    res.off("close", close);
    res.off("error", close);
    res.off("drain", drained);
    clearTimeout(drainTimer);
    cleanup();
  };
  res.on("close", close);
  res.on("error", close);
  return {
    get closed() { return closed; },
    send(event: unknown): boolean {
      if (closed || res.destroyed || res.writableEnded) { close(); return false; }
      if (blocked) return false;
      try {
        if (res.write(`data: ${JSON.stringify(event)}\n\n`)) return true;
        blocked = true;
        res.once("drain", drained);
        drainTimer = setTimeout(() => { close(); res.destroy(); }, SSE_DRAIN_TIMEOUT_MS);
        drainTimer.unref();
        return false;
      } catch { /* failed socket: close and release subscriptions below */ }
      close();
      res.destroy();
      return false;
    },
    close,
  };
}
