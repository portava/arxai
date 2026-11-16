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
// user. The fake user carries its role (users.role), the one role ARX honours
// for a signed-in caller: a cookie "u:<id>:<ROLE>" signs in that user.
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
// A test cookie value "u:<id>[:<ROLE>]" maps to a fake user carrying that id
// and role, so the per-user cooldown can be keyed independently per test.
const realUserSessions = await import("../../lib/auth/userSessions.js");
mock.module("../../lib/auth/userSessions.js", {
  namedExports: {
    ...realUserSessions,
    findUserBySessionToken: async (raw: string): Promise<User | null> => {
      const m = /^u:(\d+)(?::([A-Z]+))?$/.exec(raw);
      if (!m) return null;
      return { id: Number(m[1]), role: m[2] ?? "USER" } as unknown as User;
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
let heldScan: { started: () => void; untilReleased: Promise<void> } | null = null;

mock.module("../../lib/marketScanner.js", {
  namedExports: {
    ...realScanner,
    scanOnceSnapshot: async () => {
      if (heldScan) { heldScan.started(); await heldScan.untilReleased; }
      return {
        universe: "forex", symbols: ["EURUSD", "GBPUSD"], timeframes: ["M5"],
        opportunities: [SIM_ROW, LIVE_ROW], generatedAt: new Date().toISOString(), durationMs: 1,
      };
    },
    decorateOpportunitiesWithHistory: identityDecorator,
    decorateOpportunitiesWithNewsRisk: identityDecorator,
    decorateOpportunitiesWithTimingContext: identityDecorator,
    decorateOpportunitiesWithFvgRead: identityDecorator,
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
  // Production mounts attachAuthUser globally (app.ts): the signed-in user's
  // role is what every role gate reads.
  const { attachAuthUser } = await import("../../lib/auth/middleware.js");
  app.use(attachAuthUser);
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

function scanReq(userId: number, role: string, body: unknown = { universe: "all" }) {
  return fetch(`${base}/api/market-scanner/scan`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `arx_user_session=u:${userId}:${role}`,
    },
    body: JSON.stringify(body),
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
        cookie: "arx_user_session=u:90001:TESTER",
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

  // Simulator-derived numbers are stripped to an honest waiting state.
  assert.equal(sim.confidenceScore, 0, "masked sim row must not leak a confidence score");
  assert.equal(sim.entry, 0, "masked sim row must not leak an entry price");
  assert.equal(sim.stopLoss, 0, "masked sim row must not leak a stop-loss");
  assert.equal(sim.takeProfit, 0, "masked sim row must not leak a take-profit");
  assert.equal(sim.opportunity.score, 0, "masked sim row must zero its opportunity score");
  for (const [k, v] of Object.entries(sim.opportunity.factors)) {
    assert.equal(v, 0, `masked sim factor ${k} must be zeroed`);
  }
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


test("manual response metadata belongs to its snapshot, not another global scan", async () => {
  const response = await scanReq(90007, "TESTER");
  const body = await response.json() as { universe: string; universeSymbols: string[]; timeframes: string[]; generatedAt: string };
  assert.equal(body.universe, "forex");
  assert.deepEqual(body.universeSymbols, ["EURUSD", "GBPUSD"]);
  assert.deepEqual(body.timeframes, ["M5"]);
  assert.ok(Number.isFinite(Date.parse(body.generatedAt)));
});

test("invalid or excessive scan selections return 400 without consuming the user's cooldown", async () => {
  for (const body of [
    { symbols: [] }, { symbols: ["not-a-market"] },
    { symbols: Array(37).fill("EURUSD") },
    { timeframes: [] }, { timeframes: ["not-a-timeframe"] },
    { timeframes: Array(22).fill("M5") }, { universe: "unknown" },
  ]) {
    const response = await scanReq(90008, "TESTER", body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal((await scanReq(90008, "TESTER")).status, 200);
});


// The real route wrapper must refuse before the durable cooldown or any market
// work, and retain the existing session/role gates.
test("scanner HTTP reads refuse overload before cooldown and recover after settlement", async () => {
  const { scannerReadAdmission, SCANNER_READ_LIMITS } = await import("../../lib/scannerReadAdmission.js");
  const permits = Array.from({ length: SCANNER_READ_LIMITS.perViewer }, () => scannerReadAdmission.acquire(90001)!);
  try {
    const manual = await scanReq(90001, "USER");
    assert.equal(manual.status, 503); assert.equal(manual.headers.get("retry-after"), "1");
    assert.equal((await manual.json() as { reason: string }).reason, "SCANNER_BUSY");
    assert.equal(scanConsumed.size, 0, "a rejected operation must not consume the durable cooldown");
    for (const path of ["/market-scanner/opportunities", "/market-scanner/selected-market?symbol=EURUSD"]) {
      const res = await fetch(`${base}/api${path}`, { headers: { cookie: "arx_user_session=u:90001:USER" } });
      assert.equal(res.status, 503, path);
      const body = await res.json() as Record<string, unknown>;
      assert.equal(body.ok, false); assert.equal(body.opportunities, undefined); assert.equal(body.generatedAt, undefined);
    }
    const unsigned = await fetch(`${base}/api/market-scanner/scan`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unsigned.status, 401);
  } finally { permits.forEach(release => release()); }
  assert.equal(scannerReadAdmission.activeCount, 0);
  assert.equal((await scanReq(90001, "USER")).status, 200);
  assert.equal(scannerReadAdmission.activeCount, 0);
});

test("aborting an actual HTTP scan does not release its running provider capacity", async () => {
  const { scannerReadAdmission, SCANNER_READ_LIMITS } = await import("../../lib/scannerReadAdmission.js");
  let begin!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const untilReleased = new Promise<void>(resolve => { finish = resolve; });
  heldScan = { started: begin, untilReleased };
  const controller = new AbortController();
  const pending = fetch(`${base}/api/market-scanner/scan`, {
    method: "POST", signal: controller.signal,
    headers: { "content-type": "application/json", cookie: "arx_user_session=u:90001:USER" },
    body: JSON.stringify({ universe: "forex" }),
  });
  const aborted = assert.rejects(pending, error => (error as Error).name === "AbortError");
  const others: Array<() => void> = [];
  try {
    await started; assert.equal(scannerReadAdmission.activeCount, 1);
    controller.abort(); await aborted;
    for (let i = 1; i < SCANNER_READ_LIMITS.perViewer; i++) others.push(scannerReadAdmission.acquire(90001)!);
    assert.ok(others.every(Boolean)); assert.equal(scannerReadAdmission.activeCount, SCANNER_READ_LIMITS.perViewer);
    const refused = await fetch(`${base}/api/market-scanner/selected-market?symbol=EURUSD`, { headers: { cookie: "arx_user_session=u:90001:USER" } });
    assert.equal(refused.status, 503, "disconnected scan still owns capacity until actual work settles");
    finish();
    for (let i = 0; i < 100 && scannerReadAdmission.activeCount !== others.length; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(scannerReadAdmission.activeCount, others.length);
  } finally {
    finish(); controller.abort(); heldScan = null; others.forEach(release => release());
  }
  assert.equal(scannerReadAdmission.activeCount, 0);
});
