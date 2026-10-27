import type { Request, Response, RequestHandler } from "express";

/** Process-local admission for expensive scanner HTTP reads. These are initial
 * safety bounds, not measured production capacity or a distributed limiter. */
export const SCANNER_READ_LIMITS = Object.freeze({ total: 32, perViewer: 8 });
interface ScannerReadLimits { total: number; perViewer: number }

export class ScannerReadAdmission {
  private total = 0;
  private readonly viewers = new Map<number, number>();
  private readonly limits: Readonly<ScannerReadLimits>;
  constructor(limits: ScannerReadLimits = SCANNER_READ_LIMITS) {
    if (!Number.isSafeInteger(limits.total) || !Number.isSafeInteger(limits.perViewer)
      || limits.total < 1 || limits.perViewer < 1 || limits.perViewer > limits.total) {
      throw new RangeError("Invalid scanner read limits");
    }
    this.limits = Object.freeze({ ...limits });
  }
  get activeCount(): number { return this.total; }
  get activeViewerCount(): number { return this.viewers.size; }

  /** A null identity uses one shared anonymous bucket; untrusted tokens never
   * create admission keys. The caller must pass the resolved session identity. */
  acquire(viewerId: number | null): (() => void) | null {
    const key = typeof viewerId === "number" && Number.isSafeInteger(viewerId) && viewerId > 0 ? viewerId : 0;
    const owned = this.viewers.get(key) ?? 0;
    if (this.total >= this.limits.total || owned >= this.limits.perViewer) return null;
    this.total++;
    this.viewers.set(key, owned + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const remaining = (this.viewers.get(key) ?? 1) - 1;
      if (remaining) this.viewers.set(key, remaining);
      else this.viewers.delete(key);
    };
  }
}

export const scannerReadAdmission = new ScannerReadAdmission();
type ScannerReadHandler = (req: Request, res: Response) => unknown | Promise<unknown>;

/** Auth gates remain before this wrapper on protected routes. No queued work,
 * early success, timeout race or release-on-disconnect: an admitted operation
 * owns capacity until its handler really settles, including awaited providers. */
export function withScannerReadAdmission(
  handler: ScannerReadHandler,
  admission: ScannerReadAdmission = scannerReadAdmission,
): RequestHandler {
  return async (req, res) => {
    const release = admission.acquire(req.authUser?.id ?? null);
    if (!release) {
      res.setHeader("Retry-After", "1");
      res.setHeader("Cache-Control", "no-store");
      res.status(503).json({ ok: false, error: "SCANNER_BUSY", reason: "SCANNER_BUSY",
        message: "The scanner is busy. Try again in a moment.", retryAfterMs: 1000 });
      return;
    }
    try { await handler(req, res); }
    finally { release(); }
  };
}
