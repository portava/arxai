// Phase 22C — Legacy alert router DEPRECATED.
//
// Historical state: this router exposed /api/alerts* and /api/alert-preferences
// backed by the system-wide `alerts` and `alert_settings` tables via
// `lib/alerts/alertManager.ts`. Phase 22A gated everything behind `requireUser`
// to close an anonymous-read leak. Phase 22C now neutralises the remaining
// global-scope concern by switching every route to a per-user safe envelope
// that points internal callers at the canonical modern surface
// (`/api/me/notifications*`, `routes/meNotifications.ts`).
//
// Frontend audit (rg) confirmed zero consumers of bare /api/alerts* or
// /api/alert-preferences. `routes/scanner.ts` owns the only live alert
// endpoints (/api/alerts/scanner|acknowledge|dismiss|snooze) and is unaffected.
//
// Behaviour:
//  - GET endpoints           → 200 with deprecated empty per-user envelope
//                              + Deprecation/Link headers pointing at
//                              /api/me/notifications. Never reads the global
//                              alerts table.
//  - POST/PATCH/DELETE       → 410 Gone with deprecation envelope. Will not
//                              create duplicate notification records.
//  - Every route             → requireUser preserved (defence in depth).
//
// Do NOT add new functionality here. Build into routes/meNotifications.ts.

import { Router, type Request, type Response, type NextFunction } from "express";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

const SAFETY_ENVELOPE = {
  safetyMode: "paper_only" as const,
  liveLocked: true as const,
  readOnlyMode: true as const,
  allowOrderExecution: false as const,
};

const CANONICAL = "/api/me/notifications";
const PREFS_CANONICAL = "/api/me/notification-preferences";

function setDeprecationHeaders(res: Response, target: string): void {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", "phase-22D");
  res.setHeader("Link", `<${target}>; rel="successor-version"`);
  res.setHeader("X-ARX-Deprecated-Route", "legacy-alerts");
}

function deprecatedGet(target: string) {
  return (_req: Request, res: Response): void => {
    setDeprecationHeaders(res, target);
    res.json({
      deprecated: true,
      successor: target,
      notice: `This endpoint has been deprecated. Use ${target} for per-user notifications.`,
      notifications: [],
      alerts: [],
      unreadCount: 0,
      criticalCount: 0,
      isEmpty: true,
      ...SAFETY_ENVELOPE,
    });
  };
}

function deprecatedMutation(target: string) {
  return (req: Request, res: Response, _next: NextFunction): void => {
    req.log.warn({ path: req.path, method: req.method }, "legacy alerts mutation rejected (deprecated)");
    setDeprecationHeaders(res, target);
    res.status(410).json({
      deprecated: true,
      successor: target,
      error: "Endpoint deprecated. Use the canonical per-user notification surface.",
      ...SAFETY_ENVELOPE,
    });
  };
}

// ── GET endpoints — safe empty per-user envelopes ──────────────────────
router.get("/alerts", requireUser, deprecatedGet(CANONICAL));
router.get("/alerts/unread-count", requireUser, deprecatedGet(CANONICAL));
router.get("/alerts/critical", requireUser, deprecatedGet(CANONICAL));
router.get("/alerts/settings", requireUser, deprecatedGet(PREFS_CANONICAL));
router.get("/alert-preferences", requireUser, deprecatedGet(PREFS_CANONICAL));

// ── Mutations — 410 Gone, will not duplicate notification records ──────
router.post("/alerts", requireUser, deprecatedMutation(CANONICAL));
router.delete("/alerts", requireUser, deprecatedMutation(CANONICAL));
router.post("/alerts/:id/read", requireUser, deprecatedMutation(CANONICAL));
router.post("/alerts/read-all", requireUser, deprecatedMutation(CANONICAL));
router.post("/alerts/generate", requireUser, deprecatedMutation(CANONICAL));
router.patch("/alerts/settings", requireUser, deprecatedMutation(PREFS_CANONICAL));
router.patch("/alert-preferences", requireUser, deprecatedMutation(PREFS_CANONICAL));

export default router;
