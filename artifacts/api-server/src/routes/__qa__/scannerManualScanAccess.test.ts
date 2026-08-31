// Task #562 — the one-shot manual Broad Scan (`POST /api/market-scanner/scan`)
// is open to EVERY authenticated user, not just operators, protected by a
// per-user cooldown. The always-on engine (`/start`, `/stop`) stays admin-only.
//
// This drives the REAL scanner router over HTTP and proves:
//   (a) a normal authenticated (non-admin) user gets 200 from /scan, while
//       /start and /stop still return 403 for that same user;
//   (b) the non-admin scan response is the per-viewer PROJECTION — every
//       simulator-derived field is masked (no privileged/simulator value leaks),
//       while an ADMIN/OWNER caller still sees the unmasked simulator row;
//   (c) a second manual scan inside the cooldown window returns a clean 429 with
//       a NON-EMPTY JSON envelope, and once the cooldown clears the scan
//       succeeds again.
//
// Auth: requireUser resolves the per-user session from the `arx_user_session`
// cookie — we mock `findUserBySessionToken` so a test cookie maps to a fake
// user id. Role (for the projection) is selected with the dev-only
// `x-security-role` header, exactly like the sibling RBAC route test.
//
// The heavy scanner internals (scanOnce + the async enrichment decorators) are
// mocked to a deterministic 2-row result so the test is hermetic and fast; the
// REAL `projectOpportunitiesForViewer` runs on top of them.
//
// Run: node --import tsx --experimental-test-module-mocks --test \
//   src/routes/__qa__/scannerManualScanAccess.test.ts

import { test, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { User } from "@workspace/db";
import type { ScannerOpportunity } from "../../lib/marketScanner.js";

// ── Mock the per-user auth lookup BEFORE the router is imported ──────────────
// A test cookie value "u:<id>" maps to a fake user carrying that numeric id, so
// the per-user cooldown can be keyed independently per test.
const realUserSessions = await import("../../lib/auth/userSessions.js");
mock.module("../../lib/auth/userSessions.js", {
  namedExports: {
    ...realUserSessions,
    findUserBySessionToken: async (raw: string): Promise<User | null> => {
      const m = /^u:(\d+)$/.exec(raw);
      if (!m) return null;
      return { id: Number(m[1]) } as unknown as User;
    },
  },
});

// ── Mock the heavy scanner internals to a deterministic 2-row result ────────
const realScanner = await import("../../lib/marketScanner.js");

function opp(over: Partial<ScannerOpportunity> = {}): ScannerOpportunity {
  return {
    symbol: "EURUSD",
    timeframe: "M5",
    bias: "bullish",
    recommendedAction: "BUY",
    setupType: "Continuation",
    confidenceScore: 88,
    riskScore: 20,
    entrySniperScore: 80,
    riskRewardRatio: 2,
    reasonForTrade: "Support hold",
    reasonToAvoid: "",
    rulesPassed: [],
    rulesFailed: [],
    statusBadge: "HOT_SETUP",
    opportunity: {
      score: 88,
      label: "STRONG",
      factors: {
        trendAlignment: 80, supportResistanceQuality: 80, entryTiming: 80,
        riskRewardQuality: 80, volatilityCondition: 80, spreadCondition: 80,
        strategyMatch: 80, aiConfidenceCalibration: 80,
      },
    },
    entry: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    generatedAt: "2026-06-07T00:00:00.000Z",
    dataSource: "LIVE_FEED",
    approvedTop250: true,
    dataStatus: "live",
    selectable: true,
    tradeable: true,
    disabledReason: null,
    chartConfirmed: true,
    ...over,
  } as ScannerOpportunity;
}

const SIM_ROW = opp({ symbol: "GBPUSD", dataSource: "SIMULATOR" });
const LIVE_ROW = opp({ symbol: "EURUSD", dataSource: "LIVE_FEED" });

const identityDecorator = async (rows: ScannerOpportunity[]) => rows;

mock.module("../../lib/marketScanner.js", {
  namedExports: {
    ...realScanner,
    scanOnce: async () => [SIM_ROW, LIVE_ROW],
    decorateOpportunitiesWithHistory: identityDecorator,
    decorateOpportunitiesWithNewsRisk: identityDecorator,
    decorateOpportunitiesWithTimingContext: identityDecorator,
    decorateOpportunitiesWithFinalRead: (rows: ScannerOpportunity[]) => rows,
    effectiveOpportunityScore: (o: ScannerOpportunity) => o.opportunity?.score ?? 0,
    scannerStatus: () => ({ universe: "all", universeSymbols: [], feedNote: "" }),
  },
});

// ── Mock the DB-backed cooldown limiter ─────────────────────────────────────
// The /scan route enforces the manual-scan cooldown via the durable DB limiter
// (consumeRateLimit("MANUAL_SCAN", …)). This HTTP test stays hermetic (no DB)
// by emulating that contract in-memory: the FIRST consume per scope is allowed;
// a second within the window is blocked with a positive retryAfterMs — exactly
// what the real limiter returns. The route's real per-user scope key (hashScope)
// keys this map, so per-user isolation is exercised end-to-end. The durable DB
// path itself is proven in lib/security/__qa__/manualScanCooldownDurable.test.ts.
const realCooldowns = await import("../../lib/security/cooldowns.js");
const scanConsumed = new Set<string>();
mock.module("../../lib/security/cooldowns.js", {
  namedExports: {
    ...realCooldowns,
    consumeRateLimit: async (action: string, scopeKey: string) => {
      const blocked = action === "MANUAL_SCAN" && scanConsumed.has(scopeKey);
      if (!blocked) scanConsumed.add(scopeKey);
      const now = Date.now();
      return {
        allowed: !blocked,
        blocked,
        retryAfterMs: blocked ? 7_000 : 0,
        remaining: 0,
        nextState: {
          count: blocked ? 2 : 1,
          windowStartedAt: now,
          blockedUntil: blocked ? now + 7_000 : null,
        },
        reason: blocked ? "RATE_LIMIT_EXCEEDED" : "OK",
        action,
        scopeKey,
      };
    },
  },
});

// Import AFTER the mocks so the router binds the instrumented versions.
const scannerRouter = (await import("../scanner.js")).default;

let server: Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", scannerRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
});

beforeEach(() => {
  scanConsumed.clear();
});

function scanReq(userId: number, role: string) {
  return fetch(`${base}/api/market-scanner/scan`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `arx_user_session=u:${userId}`,
      "x-security-role": role,
    },
    body: JSON.stringify({ universe: "all" }),
  });
}

// ── (a) non-admin may run the manual scan ───────────────────────────────────

test("a normal authenticated (non-admin) user gets 200 from /scan", async () => {
  const res = await scanReq(90001, "TESTER");
  assert.equal(res.status, 200, "non-admin manual scan must be allowed (was 403 before)");
  const body = (await res.json()) as { opportunities: ScannerOpportunity[]; count: number };
  assert.ok(Array.isArray(body.opportunities), "scan must return an opportunities array");
  assert.equal(body.opportunities.length, 2, "both seeded rows must come back");
});

// An anonymous caller (no session cookie) is still rejected — the route is
// authenticated, just no longer admin-only.
test("an anonymous caller is rejected from /scan (401)", async () => {
  const res = await fetch(`${base}/api/market-scanner/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ universe: "all" }),
  });
  assert.equal(res.status, 401, "no session ⇒ AUTH_REQUIRED");
});

// ── (a cont.) the always-on engine stays operator-only ──────────────────────

for (const path of ["/api/market-scanner/start", "/api/market-scanner/stop"]) {
  test(`a non-admin user still gets 403 from POST ${path}`, async () => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "arx_user_session=u:90001",
        "x-security-role": "TESTER",
      },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403, `${path} must stay admin-only`);
  });
}

// ── (b) the non-admin response is the per-viewer projection ─────────────────

test("non-admin scan response masks the simulator-derived row", async () => {
  const res = await scanReq(90002, "TESTER");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { opportunities: ScannerOpportunity[] };

  const sim = body.opportunities.find((o) => o.symbol === "GBPUSD");
  const live = body.opportunities.find((o) => o.symbol === "EURUSD");
  assert.ok(sim, "the simulator row must be present");
  assert.ok(live, "the live row must be present");

  // Simulator-derived numbers are WITHHELD (typed nulls) — never confident
  // zeros that would render as measured scores or seed a ticket at price 0.
  assert.equal(sim.confidenceScore, null, "masked sim row must not leak a confidence score");
  assert.equal(sim.entry, null, "masked sim row must not leak an entry price");
  assert.equal(sim.stopLoss, null, "masked sim row must not leak a stop-loss");
  assert.equal(sim.takeProfit, null, "masked sim row must not leak a take-profit");
  assert.equal(sim.opportunity.score, null, "masked sim row must withhold its opportunity score");
  for (const [k, v] of Object.entries(sim.opportunity.factors)) {
    assert.equal(v, null, `masked sim factor ${k} must be withheld`);
  }
  assert.equal((sim as { withheld?: boolean }).withheld, true, "masked sim row must say WHY values are absent");
  assert.equal(sim.statusBadge, "WAIT_FOR_CONFIRMATION", "masked sim row shows the honest waiting badge");

  // The genuinely-live row is already honest and passes through unchanged.
  assert.equal(live.confidenceScore, 88, "live row must keep its real values for everyone");
});

test("an ADMIN/OWNER caller still sees the unmasked simulator row", async () => {
  const res = await scanReq(90003, "OWNER");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { opportunities: ScannerOpportunity[] };
  const sim = body.opportunities.find((o) => o.symbol === "GBPUSD");
  assert.ok(sim, "the simulator row must be present");
  assert.equal(sim.confidenceScore, 88, "operator diagnostics keep the raw simulator detail");
  assert.equal(sim.statusBadge, "HOT_SETUP", "operator sees the raw badge, not the masked one");
});

// ── (c) per-user cooldown: 429 within the window, recovers after ────────────

test("a second manual scan inside the cooldown window returns a clean 429 envelope", async () => {
  const first = await scanReq(90004, "TESTER");
  assert.equal(first.status, 200, "first scan in a fresh window must succeed");

  const second = await scanReq(90004, "TESTER");
  assert.equal(second.status, 429, "an immediate retry must be rate-limited");
  const body = (await second.json()) as { ok?: boolean; reason?: string; retryAfterMs?: number };
  assert.equal(body.ok, false, "429 body must be a non-empty JSON envelope");
  assert.equal(body.reason, "SCAN_RATE_LIMITED", "429 carries the honest reason code");
  assert.equal(typeof body.retryAfterMs, "number", "429 carries a numeric retryAfterMs");
  assert.ok((body.retryAfterMs ?? 0) > 0, "retryAfterMs must report the remaining wait");

  // Once the cooldown clears (simulated by clearing the limiter state), the
  // same user can scan again.
  scanConsumed.clear();
  const third = await scanReq(90004, "TESTER");
  assert.equal(third.status, 200, "after the cooldown window the scan succeeds again");
});

// One user's cooldown must never throttle another user.
test("the cooldown is isolated per user", async () => {
  const a = await scanReq(90005, "TESTER");
  assert.equal(a.status, 200);
  // A different user is unaffected by user 90005 having just scanned.
  const b = await scanReq(90006, "TESTER");
  assert.equal(b.status, 200, "a different user must not be throttled by another's scan");
});
