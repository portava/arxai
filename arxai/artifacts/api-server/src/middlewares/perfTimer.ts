// Server-side request timing middleware.
//
// Wraps every /api request and records into the perfRecorder ring buffer.
// Uses `process.hrtime.bigint()` for high-resolution timing.
//
// Per-route normalisation:
//   The recorder groups by `${method} ${route.path}` so that ten
//   `/api/me/positions/123/close` calls collapse into a single
//   `POST /api/me/positions/:ticket/close` action with proper p50/p95.
//   When the route hasn't matched yet (404), we fall back to the raw
//   `req.path` so we still see the cost.
//
// Safety:
//   - Reads userId from `req.authUser` if present, never from any other
//     identifier. Never logs cookies, tokens, or query strings.
//   - Never throws. A failure inside the perf hook MUST NOT break the
//     request.
//   - Does not block the response — we attach to `res.on("finish", …)`.

import type { Request, Response, NextFunction } from "express";
import { recordPerf } from "../lib/perf/perfRecorder.js";

function userIdOf(req: Request): number | null {
  // Cast through unknown — `req.authUser` is strongly typed elsewhere in
  // the codebase; we only need the numeric id and don't want to force a
  // structural match against the full user shape.
  const auth = (req as unknown as { authUser?: { id?: unknown } }).authUser;
  const id = auth?.id;
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

/**
 * Replace dynamic-looking segments (digits, long hex/uuid, very long tokens)
 * with `:x` so an unmatched 404 path like `/api/me/positions/12345/close`
 * doesn't end up in the ring buffer (or its slow-log line) as a unique
 * per-user/per-ticket string. We only apply this on the unmatched-route
 * fallback path — matched routes already use Express's parameter template.
 */
function redactDynamicSegments(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      if (seg.length === 0) return seg;
      // All-digit (ids, tickets), long hex (token-like), very long (>32).
      if (/^\d+$/.test(seg)) return ":x";
      if (/^[a-f0-9]{16,}$/i.test(seg)) return ":x";
      if (seg.length > 32) return ":x";
      return seg;
    })
    .join("/");
}

function routeLabel(req: Request): string {
  // Express sets req.route after the matched handler runs; baseUrl is the
  // mount path. Concatenating gives e.g. `/api/me/account-mode`.
  const route = (req as Request & { route?: { path?: string } }).route;
  const matched = route?.path;
  if (matched != null) {
    const base = req.baseUrl ?? "";
    const full = `${base}${matched}`.replace(/\/+/g, "/");
    return `${req.method} ${full || req.path}`;
  }
  // Unmatched (404, or middleware-only paths) — redact dynamic-looking
  // segments before they enter the ring buffer / slow-log line.
  return `${req.method} ${redactDynamicSegments(req.path)} [unmatched]`;
}

export function perfTimer(req: Request, res: Response, next: NextFunction): void {
  // Skip non-API noise; the API mount already prefixes /api but we guard
  // defensively in case of future remounts.
  if (!req.path.startsWith("/")) {
    next();
    return;
  }
  const startNs = process.hrtime.bigint();

  // Also emit Server-Timing so the browser-side perf module can split
  // "true backend ms" from "network/parse ms" without a separate roundtrip.
  // We patch writeHead so the header lands on EVERY response (the route
  // handlers do `res.json(...)` which flushes headers immediately, so a
  // pre-flush set is the only way to inject it without races).
  const origWriteHead = res.writeHead.bind(res);
  // The Express type for writeHead has multiple overloads; we cast to
  // `unknown` first to avoid having to mirror every signature.
  (res as unknown as { writeHead: (...a: unknown[]) => Response }).writeHead = ((...args: unknown[]) => {
    try {
      const ms = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      // Don't override if a downstream handler already set Server-Timing.
      if (!res.getHeader("Server-Timing")) {
        res.setHeader("Server-Timing", `app;dur=${ms.toFixed(1)}`);
      }
      // Always expose for CORS clients (the dashboard is same-origin in
      // dev/prod, but Expo and any future cross-origin client needs this).
      if (!res.getHeader("Access-Control-Expose-Headers")) {
        res.setHeader("Access-Control-Expose-Headers", "Server-Timing");
      }
    } catch { /* never break the response */ }
    return (origWriteHead as (...a: unknown[]) => Response)(...args);
  }) as typeof res.writeHead;

  res.on("finish", () => {
    try {
      const endNs = process.hrtime.bigint();
      const totalMs = Number(endNs - startNs) / 1_000_000;
      recordPerf({
        source: "server",
        action: routeLabel(req),
        method: req.method,
        status: res.statusCode,
        userId: userIdOf(req),
        totalMs,
        apiMs: totalMs,
      });
    } catch {
      // Never let perf instrumentation impact the response.
    }
  });
  next();
}
