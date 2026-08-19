// Global per-user auth gate.
//
// PHASE-1 SAFETY NET: Until every route is individually wrapped in
// `requireUser` (Phase 3 of the per-user isolation refactor), this middleware
// 401s any /api/* request that does not have an authenticated user, EXCEPT
// for an explicit allowlist of paths that must remain public:
//
//   - health checks
//   - the auth router (register/login/logout/session)
//   - MT5 bridge endpoints (which have their own X-MT5-Bridge-Token guard
//     and stay fail-closed when the token env is unset)
//   - app version + release info (used by the splash page before login)
//
// Phase 3 of the per-user isolation refactor LANDED (closed May 17, 2026 —
// see docs/TODO_PER_USER_ISOLATION.md): `requireUser` is wired on every
// private route file and per-user reads/writes are scoped by
// `eq(<table>.userId, req.authUser.id)` at the query layer. This gate is now
// belt-and-braces, kept deliberately as an allowlist (deny-by-default) so a
// forgotten future route fails closed rather than open.
//
// IMPORTANT: this gate still does NOT replace per-user query scoping — any
// NEW route must scope its queries by req.authUser.id; the CI guard
// scripts/src/ci checks (perUserIsolationMeRoutes) enforce the /me surface.

import type { Request, Response, NextFunction } from "express";

// Paths are matched relative to the /api mount point (i.e. req.path here is
// "/trades", not "/api/trades", because this middleware runs inside the /api
// router). Use exact matches and prefix matches.
const PUBLIC_EXACT = new Set<string>([
  "/healthz",
  "/health",
  "/version",
  // MT5 bridge endpoints — gated by X-MT5-Bridge-Token, fail-closed when
  // MT5_BRIDGE_TOKEN env is unset.
  "/mt5/heartbeat",
  "/mt5/commands",
  "/mt5/command-result",
  "/mt5/sync-account",
  "/mt5/sync-positions",
  "/mt5/sync-positions-per-user",
  // EA v1.50 telemetry snapshot endpoints. Like the other bridge endpoints
  // they carry no user session — only the per-user X-MT5-Bridge-Token — so the
  // global gate must let them through to `bridgeAuthPerUserOnly`. Without these
  // entries the EA receives HTTP 401 on every positions/pending push before the
  // token check can run. Read + record only; neither weakens a safety surface.
  "/mt5/positions-snapshot",
  "/mt5/pending-snapshot",
  // EA market-data push endpoints. Same contract as the telemetry snapshots:
  // the EA carries only the per-user X-MT5-Bridge-Token (no user session), so
  // the global gate must allow the request through to `bridgeAuthPerUserOnly`
  // inside the handler. Without these entries the EA receives HTTP 401 on every
  // candle/quote push before the token check can run. Market-data only — no DB
  // write, no execution, no gate involvement; malformed/impossible OHLC is
  // rejected and no candle is ever fabricated.
  "/mt5/sync-candles",
  "/mt5/sync-quotes",
  // Task #469 — EA-facing durable broker-candle batch ingest. Same contract as
  // the other market-data push endpoints: the EA carries only the per-user
  // X-MT5-Bridge-Token (no user session), so the global gate must let the
  // request through to `bridgeAuthPerUserOnly` inside the handler. Telemetry
  // only — finalizes closed bars into a durable store and mirrors accepted
  // CLOSED bars into the market-data read path; no execution, no gate, and
  // malformed/stale/out-of-sequence bars are rejected (never fabricated).
  "/mt5/candles/ingest",
  // Phase 28-MT5-DEMO-ARMING sub-phase 3B: EA-side demo dispatch endpoints.
  // Both are gated by bridgeAuthPerUserOnly inside the route handler — the
  // global gate must let them through so the per-user token check can run.
  "/mt5/demo-commands-poll",
  "/mt5/demo-command-result",
  "/mt5/execution-result",
  // Phase B EA-side LIVE endpoints. Same contract as the demo endpoints:
  // they're gated by `bridgeAuthPerUserOnly` inside the route handler so the
  // global session gate must allow them through (the EA has no session
  // cookie). Without these entries the EA receives HTTP 401 AUTH_REQUIRED
  // on /live-commands-poll even when the per-user bridge token is valid —
  // the bridge auth middleware never runs because the global gate already
  // rejected the request. Token verification, accountType=live/real check,
  // mock-bridge refusal, and the full 16-gate Phase B dispatch pipeline
  // still apply on every request.
  "/mt5/live-commands-poll",
  "/mt5/live-command-result",
  "/mt5/sync-live-positions",
  // Task #32 — EA-facing remote-ops endpoints. Each is gated by
  // bridgeAuthPerUserOnly inside the route handler; the global gate must let
  // the unauthenticated (no user session) request through so the per-user
  // X-MT5-Bridge-Token check can run. None of these can weaken a safety
  // surface: remote-config serves only allow-listed tunables, update-check
  // serves only an APPROVED manifest, update-report is write-only audit.
  "/mt5/remote-config",
  "/mt5/update-check",
  "/mt5/update-report",
  // Task #371 — Bridge v2 broker-truth EVENT ingest. Like every other EA
  // endpoint it carries NO session; it is gated by `bridgeAuthPerUserOnly`
  // (per-user X-MT5-Bridge-Token only) inside the route handler. The global
  // gate must let the unauthenticated POST through so that token check can run.
  "/bridge/v2/ingest",
  // Task #397 — Bridge v2 EA pull surfaces (config manifest + whitelisted
  // command channel). Both carry NO session; they are gated by
  // `bridgeAuthPerUserOnly` (per-user X-MT5-Bridge-Token only) inside the route
  // handler, so the global gate must let the unauthenticated GET through.
  "/bridge/v2/config",
  "/bridge/v2/commands",
  // TradingView webhook intake — public ingress; secured by per-user
  // X-TV-Webhook-Token (SHA-256 hashed at rest) validated inside the
  // route handler. The global gate must let unauthenticated POSTs through
  // so the token check can run; without this entry every TradingView
  // alert is rejected with HTTP 401 before reaching the token validator.
  "/webhooks/tradingview",
]);

const PUBLIC_PREFIXES: readonly string[] = [
  "/health/",       // any nested health check
  "/auth/",         // register, login, logout, user-logout, session (role layer)
  "/auth",          // bare /auth for safety
  "/release/",      // release info shown pre-login
  "/release",
];

function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  for (const prefix of PUBLIC_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(prefix)) return true;
  }
  return false;
}

export function requireAuthOrPublic(req: Request, res: Response, next: NextFunction): void {
  // Allow CORS preflight unconditionally.
  if (req.method === "OPTIONS") {
    next();
    return;
  }
  if (req.authUser) {
    next();
    return;
  }
  // path is the request path WITHOUT the /api prefix (router-relative).
  const pathname = req.path || "/";
  if (isPublic(pathname)) {
    next();
    return;
  }
  res.status(401).json({ error: "AUTH_REQUIRED", message: "Sign in required." });
}
