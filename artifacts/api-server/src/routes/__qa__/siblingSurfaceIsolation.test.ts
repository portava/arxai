// Sibling-surface isolation — the routers the FIRST isolation pass missed.
//
// The first pass scoped nine named routers and shipped a CI guard whose
// coverage list named exactly those nine. The user-visible defect it was
// supposed to close was still reachable through routers nobody had listed:
//
//   * routes/tradeDecision.ts — `orchestrate(input, userId)` already RECEIVED
//     the caller's id and then read analytics_snapshots, trader_skill_profiles,
//     ai_mentor_sessions and trading_readiness_checks with
//     `.orderBy(desc(...)).limit(1)` and NO predicate. It then emitted
//     "Analytics: <symbol> is your WEAKEST symbol (PF=…)" and scored the trade
//     against a stranger's discipline score, mentor flag and readiness status.
//     POST /trade-decision/evaluate is requireUser-gated, so every signed-in
//     trader hit it.
//   * routes/tradingReadiness.ts — took the newest weekly_performance_reviews
//     row platform-wide and returned trading_readiness_checks unscoped.
//   * routes/ruleContracts.ts / routes/postTradeDebriefs.ts — the WRITE side.
//     Their inserts never stamped user_id, so the first pass's read-side
//     `eq(table.userId, userId)` predicates could never match anything:
//     `violations.length` was permanently 0 and Trader Skill handed every
//     trader a confident Risk score of 100.
//   * routes/paperExecution.ts — executed paper trades with no caller
//     identity at all.
//
// This lane pins the auth gate on every one of those routes. The SCOPING
// itself (the `eq(…, userId)` predicates and the owner-stamped inserts) is
// pinned by scripts/src/ci/perUserIsolationMeRoutes.ts rules R3/R4, whose
// coverage list now names these five files and whose QA suite asserts that
// list can never shrink again.
//
// Run: node --import tsx --test src/routes/__qa__/siblingSurfaceIsolation.test.ts

process.env["DATABASE_URL"] ??= "postgres://user:pass@127.0.0.1:1/nonexistent";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Request, Response } from "express";

const [
  { default: tradeDecisionRouter },
  { default: tradingReadinessRouter },
  { default: ruleContractsRouter },
  { default: postTradeDebriefsRouter },
  { default: paperExecutionRouter },
] = await Promise.all([
  import("../tradeDecision.js"),
  import("../tradingReadiness.js"),
  import("../ruleContracts.js"),
  import("../postTradeDebriefs.js"),
  import("../paperExecution.js"),
]);

type Handler = (req: Request, res: Response, next: (err?: unknown) => void) => void;

interface Captured { status: number | null; body: unknown; reachedHandler: boolean }

/** Drive one route through the real router with NO authenticated user. */
function callAnonymously(router: unknown, method: string, url: string): Promise<Captured> {
  return new Promise<Captured>((resolve, reject) => {
    const out: Captured = { status: null, body: null, reachedHandler: false };
    const res: Record<string, unknown> & { headersSent: boolean } = {
      headersSent: false,
      status(code: number) { out.status = code; return res; },
      json(body: unknown) { out.body = body; res.headersSent = true; resolve(out); return res; },
      send(body: unknown) { out.body = body; res.headersSent = true; resolve(out); return res; },
      end() { res.headersSent = true; resolve(out); return res; },
      setHeader() { return res; },
      getHeader() { return undefined; },
      type() { return res; },
      vary() { return res; },
    };

    const req = {
      method,
      url,
      originalUrl: `/api${url}`,
      baseUrl: "",
      path: url.split("?")[0],
      headers: {},
      header: () => undefined,
      get: () => undefined,
      query: {},
      params: {},
      body: {},
      cookies: {},
      signedCookies: {},
      // No authUser — that is the whole point of this suite.
      log: { info: () => {}, warn: () => {}, error: () => {} },
      res: res as unknown as Response,
    } as unknown as Request;
    (res as { req?: Request }).req = req;

    const timer = setTimeout(() => reject(new Error(`no response for ${method} ${url}`)), 5_000);
    const done = (err?: unknown) => {
      clearTimeout(timer);
      if (err) { reject(err instanceof Error ? err : new Error(String(err))); return; }
      out.reachedHandler = true;
      resolve(out);
    };
    try {
      (router as Handler)(req, res as unknown as Response, done);
    } catch (e) {
      clearTimeout(timer);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

const CASES: Array<{ surface: string; router: unknown; method: string; url: string }> = [
  // Rank 9/10/11's actual live path.
  { surface: "Trade decision — evaluate (reads analytics/skill/mentor/readiness)",
    router: tradeDecisionRouter, method: "POST", url: "/trade-decision/evaluate" },
  { surface: "Trade decision — demo evaluate",
    router: tradeDecisionRouter, method: "POST", url: "/trade-decision/demo" },
  { surface: "Trade decision — decision log listing",
    router: tradeDecisionRouter, method: "GET", url: "/trade-decision/logs" },
  { surface: "Trade decision — latest decision",
    router: tradeDecisionRouter, method: "GET", url: "/trade-decision/latest" },

  // Rank 8's second live path.
  { surface: "Readiness — submit + persist a readiness check",
    router: tradingReadinessRouter, method: "POST", url: "/readiness/checks" },
  { surface: "Readiness — latest check",
    router: tradingReadinessRouter, method: "GET", url: "/readiness/checks/latest" },
  { surface: "Readiness — check history",
    router: tradingReadinessRouter, method: "GET", url: "/readiness/checks" },
  { surface: "Readiness — dry-run evaluate (reads a weekly review)",
    router: tradingReadinessRouter, method: "POST", url: "/readiness/evaluate" },

  // The write side of the Trader Skill Risk pillar.
  { surface: "Rule contracts — list",
    router: ruleContractsRouter, method: "GET", url: "/rule-contracts" },
  { surface: "Rule contracts — active contract",
    router: ruleContractsRouter, method: "GET", url: "/rule-contracts/active" },
  { surface: "Rule contracts — create (deactivates the caller's other contracts)",
    router: ruleContractsRouter, method: "POST", url: "/rule-contracts" },
  { surface: "Rule contracts — patch a stranger's contract",
    router: ruleContractsRouter, method: "PATCH", url: "/rule-contracts/1" },
  { surface: "Rule contracts — evaluate (writes violation rows)",
    router: ruleContractsRouter, method: "POST", url: "/rule-contracts/1/evaluate" },
  { surface: "Rule contracts — a stranger's violations",
    router: ruleContractsRouter, method: "GET", url: "/rule-contracts/1/violations" },
  { surface: "Session commitments — start",
    router: ruleContractsRouter, method: "POST", url: "/session-commitments" },
  { surface: "Session commitments — end a stranger's commitment",
    router: ruleContractsRouter, method: "POST", url: "/session-commitments/1/end" },
  { surface: "Session commitments — active",
    router: ruleContractsRouter, method: "GET", url: "/session-commitments/active" },

  // The manual debrief writer (four Trader Skill pillars depend on it).
  { surface: "Post-trade debriefs — create",
    router: postTradeDebriefsRouter, method: "POST", url: "/post-trade-debriefs" },
  { surface: "Post-trade debriefs — list",
    router: postTradeDebriefsRouter, method: "GET", url: "/post-trade-debriefs" },
  { surface: "Post-trade debriefs — a stranger's debrief by trade",
    router: postTradeDebriefsRouter, method: "GET", url: "/post-trade-debriefs/by-trade/1" },
  { surface: "Post-trade debriefs — patch a stranger's debrief",
    router: postTradeDebriefsRouter, method: "PATCH", url: "/post-trade-debriefs/1" },
  { surface: "Post-trade debriefs — regenerate a stranger's feedback",
    router: postTradeDebriefsRouter, method: "POST", url: "/post-trade-debriefs/1/regenerate" },

  // Rank 36's enforcement caller.
  { surface: "Paper execution — execute from a decision",
    router: paperExecutionRouter, method: "POST", url: "/paper-execution/from-decision" },
  { surface: "Paper execution — demo execute",
    router: paperExecutionRouter, method: "POST", url: "/paper-execution/demo" },
  { surface: "Paper execution — open executions",
    router: paperExecutionRouter, method: "GET", url: "/paper-execution/open" },
  { surface: "Paper execution — trade listing",
    router: paperExecutionRouter, method: "GET", url: "/paper-execution/trades" },
  { surface: "Paper execution — a stranger's execution by id",
    router: paperExecutionRouter, method: "GET", url: "/paper-execution/trade/1" },
  { surface: "Paper execution — close a stranger's paper order",
    router: paperExecutionRouter, method: "POST", url: "/paper-execution/close/1" },
];

for (const c of CASES) {
  test(`401 for a logged-out caller: ${c.method} ${c.url} (${c.surface})`, async () => {
    const r = await callAnonymously(c.router, c.method, c.url);
    assert.equal(
      r.reachedHandler, false,
      "a logged-out request reached the handler — the auth gate is missing",
    );
    assert.equal(r.status, 401, `expected 401, got ${r.status} with body ${JSON.stringify(r.body)}`);
    assert.equal((r.body as { error?: string })?.error, "AUTH_REQUIRED");
  });
}

test("the sweep still covers all five sibling routers", () => {
  const routers = new Set(CASES.map((c) => c.router));
  assert.equal(routers.size, 5, "one or more routers dropped out of this proof");
  assert.ok(CASES.length >= 25, "the anonymous-access sweep must not shrink");
});

// ── Source pins: fabricated limits must not come back ──────────────────────
//
// These are the kind of claim a unit test cannot make: the defect is a
// LITERAL sitting in a response object. Mutate either constant back in and
// these go red.

const SRC = join(import.meta.dirname, "..", "..");

test("the Trader Coach daily view no longer ships invented session limits", () => {
  const raw = readFileSync(join(SRC, "routes", "traderCoach.ts"), "utf-8");
  assert.ok(
    !/sessionLimits:\s*\{\s*maxTradesPerDay:\s*5\s*,\s*maxLossPerDay:\s*100\s*\}/.test(raw),
    "the hardcoded { maxTradesPerDay: 5, maxLossPerDay: 100 } is back — those are not the reader's limits",
  );
  assert.ok(
    /sessionLimits:\s*r\.sessionLimits/.test(raw),
    "the daily view must forward the report's real per-trader session limits",
  );
});

test("the weekly plan's paper-trading targets are read, not invented", () => {
  const raw = readFileSync(join(SRC, "lib", "traderCoach", "weekly.ts"), "utf-8");
  assert.ok(
    !/maxTradesPerDay:\s*5\s*,/.test(raw) && !/maxLossPerDay:\s*100\s*,/.test(raw),
    "the hardcoded 5 / 100 weekly targets are back",
  );
  assert.ok(
    raw.includes("getOrCreateUserRiskSettings"),
    "maxTradesPerDay must come from the trader's own risk settings",
  );
  assert.ok(
    raw.includes("limitBasis"),
    "the plan must report the basis of the dollar limit so UNKNOWN stays visible",
  );
});

test("the daily loss reminder never names a dollar figure the governor did not derive", () => {
  const raw = readFileSync(join(SRC, "routes", "traderCoach.ts"), "utf-8");
  // The dollar branch must be guarded by an explicit non-null check on the
  // derived limit; the fallback branch must not print a number at all.
  assert.ok(
    /r\.sessionLimits\.maxLossPerDayUsd\s*!=\s*null/.test(raw),
    "the reminder must only quote a dollar limit when one was actually derived",
  );
});

test("the tester seed refuses to write fabricated rows it cannot attribute", () => {
  const raw = readFileSync(join(SRC, "routes", "testerData.ts"), "utf-8");
  // Built from parts on purpose: a literal `router.post("…")` inside a test
  // file is picked up by the route-collisions CI guard as a real second
  // registration of that path.
  const seedStart = raw.indexOf(["router", ".post(", '"/tester-data/seed"'].join(""));
  const firstInsert = raw.indexOf("db.insert(", seedStart);
  const guard = raw.indexOf("seederUserId == null", seedStart);
  assert.ok(guard > seedStart, "the unowned-seeder guard is gone");
  assert.ok(
    guard < firstInsert,
    "the guard must run BEFORE the first insert — refusing after writing intents and "
    + "append-only vault rows would leave the seed half-applied",
  );
});

test("the clear endpoint reports the seeded rows it could NOT delete", () => {
  const raw = readFileSync(join(SRC, "routes", "testerData.ts"), "utf-8");
  assert.ok(
    raw.includes("seededJournalRowsOwnedByOthersRemaining"),
    "clear must count the seeded rows owned by another admin instead of implying the seed was fully undone",
  );
  assert.ok(
    !/note:\s*"Seeded intents and seeded journal rows were deleted\./.test(raw),
    "the old unconditional 'were deleted' note is back — it is not true for another admin's rows",
  );
});
