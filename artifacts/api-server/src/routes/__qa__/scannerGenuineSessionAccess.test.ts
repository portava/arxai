// Real user-session scanner access: role masking and operator-only controls use
// the resolved user record. Signed legacy role cookies cannot elevate that role.
// Provider reads, users and cooldowns are fixtures; no broker or database I/O.

import { test, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { User } from "@workspace/db";
import type { ScannerOpportunity } from "../../lib/marketScanner.js";

// Signed-in users now take their role from the resolved user record, not the
// legacy signed role cookie. Mirror production's attachAuthUser middleware and
// give the mocked session lookup an explicit user role.
const sessionRoles = new Map<number, string>();
const realUserSessions = await import("../../lib/auth/userSessions.js");
mock.module("../../lib/auth/userSessions.js", {
  namedExports: {
    ...realUserSessions,
    findUserBySessionToken: async (raw: string): Promise<User | null> => {
      const m = /^u:(\d+)$/.exec(raw);
      if (!m) return null;
      return { id: Number(m[1]), role: sessionRoles.get(Number(m[1])) ?? "VIEWER" } as unknown as User;
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
    scanOnceSnapshot: async () => ({
      universe: "all", symbols: ["EURUSD", "GBPUSD"], timeframes: ["M5"],
      opportunities: [SIM_ROW, LIVE_ROW], generatedAt: new Date().toISOString(), durationMs: 1,
    }),
    decorateOpportunitiesWithHistory: identityDecorator,
    decorateOpportunitiesWithNewsRisk: identityDecorator,
    decorateOpportunitiesWithTimingContext: identityDecorator,
    decorateOpportunitiesWithFvgRead: identityDecorator,
    decorateOpportunitiesWithFinalRead: (rows: ScannerOpportunity[]) => rows,
    effectiveOpportunityScore: (o: ScannerOpportunity) => o.opportunity?.score ?? 0,
    scannerStatus: () => ({ universe: "all", universeSymbols: [], feedNote: "" }),
  },
});

// ── Mock the DB-backed cooldown limiter (hermetic, no DB) ───────────────────
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
        nextState: { count: blocked ? 2 : 1, windowStartedAt: now, blockedUntil: blocked ? now + 7_000 : null },
        reason: blocked ? "RATE_LIMIT_EXCEEDED" : "OK",
        action,
        scopeKey,
      };
    },
  },
});

// Import AFTER the mocks so the router binds the instrumented versions. The real
// `encodeSession` is used to mint genuine signed cookies — same module singleton
// the router verifies against.
const { encodeSession } = await import("../../lib/security/session.js");
type SignableRole = Parameters<typeof encodeSession>[0]["role"];
const scannerRouter = (await import("../scanner.js")).default;

let server: Server;
let base: string;

/** A genuine, signed `hr_session` role cookie (no dev header involved). */
function signedRoleCookie(role: SignableRole): string {
  return encodeSession({ sid: `test-${role}`, role, ts: Date.now() });
}

/** Cookie header carrying BOTH the per-user session AND a signed role cookie. */
function cookies(userId: number, role: SignableRole): string {
  sessionRoles.set(userId, role);
  return `arx_user_session=u:${userId}; hr_session=${signedRoleCookie(role)}`;
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const { attachAuthUser } = await import("../../lib/auth/middleware.js");
  app.use(attachAuthUser);
  app.use("/api", scannerRouter);
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

beforeEach(() => { scanConsumed.clear(); sessionRoles.clear(); });

function scan(userId: number, role: SignableRole) {
  return fetch(`${base}/api/market-scanner/scan`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: cookies(userId, role) },
    body: JSON.stringify({ universe: "all" }),
  });
}

// ── (a) non-admin VIEWER: 200 + simulator row masked via the signed cookie ──

test("a VIEWER (genuine signed cookie, no dev header) gets 200 and the simulator row masked", async () => {
  const res = await scan(90101, "VIEWER");
  assert.equal(res.status, 200, "non-admin manual scan must be allowed");
  const body = (await res.json()) as { opportunities: ScannerOpportunity[] };

  const sim = body.opportunities.find((o) => o.symbol === "GBPUSD");
  const live = body.opportunities.find((o) => o.symbol === "EURUSD");
  assert.ok(sim, "the simulator row must be present");
  assert.ok(live, "the live row must be present");

  // Driven purely by the signed role cookie — every simulator number is stripped.
  assert.equal(sim.confidenceScore, 0, "masked sim row must not leak a confidence score");
  assert.equal(sim.entry, 0, "masked sim row must not leak an entry price");
  assert.equal(sim.stopLoss, 0, "masked sim row must not leak a stop-loss");
  assert.equal(sim.takeProfit, 0, "masked sim row must not leak a take-profit");
  assert.equal(sim.opportunity.score, 0, "masked sim row must zero its opportunity score");
  for (const [k, v] of Object.entries(sim.opportunity.factors)) {
    assert.equal(v, 0, `masked sim factor ${k} must be zeroed`);
  }
  assert.equal(sim.statusBadge, "WAIT_FOR_CONFIRMATION", "masked sim row shows the honest waiting badge");

  // The genuinely-live row is honest and passes through unchanged for everyone.
  assert.equal(live.confidenceScore, 88, "live row must keep its real values");
});

// ── (b) OWNER: same signed-cookie path, but full operator diagnostics ───────

test("an OWNER (genuine signed cookie) still sees the unmasked simulator row", async () => {
  const res = await scan(90102, "OWNER");
  assert.equal(res.status, 200);
  const body = (await res.json()) as { opportunities: ScannerOpportunity[] };
  const sim = body.opportunities.find((o) => o.symbol === "GBPUSD");
  assert.ok(sim, "the simulator row must be present");
  assert.equal(sim.confidenceScore, 88, "operator diagnostics keep the raw simulator detail");
  assert.equal(sim.statusBadge, "HOT_SETUP", "operator sees the raw badge, not the masked one");
});

// ── (c) the always-on engine stays operator-only for the SAME signed cookie ─

for (const path of ["/api/market-scanner/start", "/api/market-scanner/stop"]) {
  test(`a VIEWER (genuine signed cookie) still gets 403 from POST ${path}`, async () => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookies(90103, "VIEWER") },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403, `${path} must stay admin-only`);
  });
}


test("a signed OWNER role cookie cannot elevate a resolved VIEWER session", async () => {
  sessionRoles.set(90104, "VIEWER");
  const response = await fetch(`${base}/api/market-scanner/scan`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `arx_user_session=u:90104; hr_session=${signedRoleCookie("OWNER")}` },
    body: JSON.stringify({ universe: "all" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { opportunities: ScannerOpportunity[] };
  assert.equal(body.opportunities.find((row: ScannerOpportunity) => row.symbol === "GBPUSD")?.confidenceScore, 0);
});
