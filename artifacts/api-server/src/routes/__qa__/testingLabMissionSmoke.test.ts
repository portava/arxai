// Task — end-to-end smoke for the Testing Lab run→result flow and the Profit
// Mission create→pulse→approve lifecycle, at the ROUTE layer against a real DB.
//
// The audit confirmed both surfaces are structurally sound, but their existing
// coverage is unit/domain-level (plus per-invariant route suites). This suite is
// the fast wide smoke that locks the two KEY USER FLOWS end to end, hitting the
// real routes with the real `db` (no mocked internals):
//   (A) Testing Lab: POST /api/backtest-runs (deterministic seed) returns a
//       COMPLETED run with real metrics, and the results then APPEAR via
//       GET /backtest-runs (list), GET /backtest-runs/:id (detail +
//       dataReliability), and GET /backtest-runs/:id/trades (per-trade rows
//       matching totalTrades).
//   (B) Profit Mission: POST /api/profit-missions creates a draft whose pulse
//       (GET /:id/pulse) is non-empty with a non-null `feasibility`; then an
//       actionable seeded proposal is APPROVED into an `approved` trade draft
//       (never `executed` — approval is not execution).
//
// Determinism: the backtest route generates candles from a deterministic seed
// (strategy|symbol|timeframe) anchored at a fixed baseTime, so the
// trendContinuation/EURUSD/M1 config below always produces trades (verified
// empirically: 31 trades at minConfidence 40) — no feed or provider dependence.
//
// Imports the routers → pulls in `@workspace/db` (module init throws with no
// DATABASE_URL), so this lives in the DB-backed integration lane
// (`runIntegrationCiTests.ts`), not the offline `ci` lane.
//
// SAFETY / SCOPE: display + planning surfaces only. The backtest path is pure
// historical simulation; mission approval produces an approval artifact and a
// journal event, never an order. Seeds one isolated system user and its own
// backtest run; cleans up its rows in a finally-equivalent `after` hook (vault
// BEHAVIOR telemetry rows are append-only and are left untouched).
//
// Run: pnpm --filter @workspace/api-server run test:testing-lab-smoke

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  usersTable,
  authUserSessionsTable,
  backtestRunsTable,
  backtestTradesTable,
  profitMissionsTable,
  missionAgentsTable,
  missionProposalsTable,
  missionTradeDraftsTable,
  missionEventsTable,
} from "@workspace/db";
import { computeEdgeScore } from "@workspace/domain/profit-mission";
import { createUserSession } from "../../lib/auth/userSessions.js";
import backtestRunsRouter from "../backtestRuns.js";
import profitMissionsRouter from "../profitMissions.js";

const EMAIL = "qa+testing-lab-smoke@arx.test";

let server: Server;
let base: string;
let userId: number;
let cookie: string;
const createdRunIds: number[] = [];

async function cleanup(): Promise<void> {
  if (createdRunIds.length > 0) {
    await db.delete(backtestTradesTable).where(inArray(backtestTradesTable.backtestRunId, createdRunIds));
    await db.delete(backtestRunsTable).where(inArray(backtestRunsTable.id, createdRunIds));
    createdRunIds.length = 0;
  }
  const rows = await db.select().from(usersTable).where(eq(usersTable.email, EMAIL));
  for (const u of rows) {
    const owned = await db
      .select({ id: profitMissionsTable.id })
      .from(profitMissionsTable)
      .where(eq(profitMissionsTable.userId, u.id));
    const ids = owned.map((m) => m.id);
    if (ids.length > 0) {
      await db.delete(missionTradeDraftsTable).where(inArray(missionTradeDraftsTable.missionId, ids));
      await db.delete(missionProposalsTable).where(inArray(missionProposalsTable.missionId, ids));
      await db.delete(missionAgentsTable).where(inArray(missionAgentsTable.missionId, ids));
      await db.delete(missionEventsTable).where(inArray(missionEventsTable.missionId, ids));
    }
    await db.delete(profitMissionsTable).where(eq(profitMissionsTable.userId, u.id));
    await db.delete(authUserSessionsTable).where(eq(authUserSessionsTable.userId, u.id));
    await db.delete(usersTable).where(eq(usersTable.id, u.id));
  }
}

function req(path: string, withCookie: boolean, init?: RequestInit) {
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (withCookie) headers["cookie"] = cookie;
  return fetch(`${base}${path}`, { ...init, headers });
}

function postJson(path: string, withCookie: boolean, body: unknown) {
  return req(path, withCookie, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

before(async () => {
  await cleanup();
  const inserted = await db
    .insert(usersTable)
    .values({ email: EMAIL, name: "QA Testing Lab Smoke", role: "USER", isSystemUser: true })
    .returning();
  userId = inserted[0]!.id;
  const { rawToken } = await createUserSession({ userId });
  cookie = `arx_user_session=${rawToken}`;

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // The real app attaches a pino req.log; the backtest routes only touch it in
  // their catch blocks, but shim it so an unexpected error surfaces as a clean
  // 500 (assertion failure) instead of a crash inside the error handler.
  app.use((r, _res, next) => {
    (r as unknown as { log: Record<string, (..._a: unknown[]) => void> }).log = {
      error: () => {}, warn: () => {}, info: () => {}, debug: () => {},
    };
    next();
  });
  app.use("/api", backtestRunsRouter);
  app.use("/api", profitMissionsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

// ── (A) Testing Lab: submit a run → it completes → results appear ────────────

interface RunDto {
  id: number;
  strategyId: string;
  symbol: string;
  timeframe: string;
  status: string;
  isVerified: string;
  dataSource?: string;
  aiSummary?: string | null;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  netProfitLoss: number;
  winRate: number;
  equityCurve?: number[];
  arxFocus?: { approved: boolean } | Record<string, unknown>;
  dataReliability?: unknown;
}

let runId: number;
let createdRun: RunDto;

test("POST /backtest-runs completes a deterministic run with real metrics", async () => {
  const res = await postJson("/api/backtest-runs", false, {
    strategyId: "trendContinuation",
    symbol: "EURUSD",
    timeframe: "M1",
    candleCount: 1000,
    minConfidence: 40,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as RunDto;
  assert.ok(Number.isFinite(body.id), "run row persisted with an id");
  runId = body.id;
  createdRunIds.push(runId);
  createdRun = body;

  // A valid COMPLETED result row: the deterministic config always trades.
  assert.equal(body.status, "COMPLETED", "run completes (not INSUFFICIENT_DATA)");
  assert.ok(body.totalTrades > 0, "the run produced trades");
  assert.equal(body.winningTrades + body.losingTrades <= body.totalTrades, true);
  assert.ok(Number.isFinite(body.netProfitLoss), "netProfitLoss is a real number");
  assert.ok(body.winRate >= 0 && body.winRate <= 100, "winRate within [0,100]");
  // CORRECTED (audit rank 41): this used to accept "VERIFIED" for this run.
  // This request supplies no history window and CI has no broker candles, so it
  // runs on fabricated candles — a run that can never be verified. Accepting
  // VERIFIED here was asserting something false. A synthetic run's honest
  // verdict is SYNTHETIC_NOT_VERIFIABLE; VERIFIED/UNVERIFIED remain the verdicts
  // for a run over real broker bars.
  assert.equal(
    body.isVerified, "SYNTHETIC_NOT_VERIFIABLE",
    "a run on fabricated candles must never be stamped VERIFIED",
  );
  assert.equal(body.dataSource, "synthetic", "no broker history in this environment");
  assert.match(
    body.aiSummary ?? "", /^SYNTHETIC DATA —/,
    "the stored summary must open by saying the candles were fabricated",
  );
  assert.ok(Array.isArray(body.equityCurve) && body.equityCurve.length > 0, "equity curve returned");
});

test("the completed run's results appear via list, detail, and trades", async () => {
  // List surfaces the run.
  const listRes = await req("/api/backtest-runs?limit=200", false);
  assert.equal(listRes.status, 200);
  const list = (await listRes.json()) as { runs: RunDto[] };
  assert.equal(list.runs.some((r) => r.id === runId), true, "run appears in the Testing Lab list");

  // Detail returns the persisted metrics + the display-only reliability verdict.
  const getRes = await req(`/api/backtest-runs/${runId}`, false);
  assert.equal(getRes.status, 200);
  const detail = (await getRes.json()) as RunDto;
  assert.equal(detail.id, runId);
  assert.equal(detail.status, "COMPLETED");
  assert.equal(detail.totalTrades, createdRun.totalTrades, "detail metrics match the created run");
  assert.equal(detail.netProfitLoss, createdRun.netProfitLoss);
  assert.ok(detail.dataReliability != null, "detail carries the dataReliability verdict");

  // Per-trade detail matches the run's totalTrades exactly.
  const tradesRes = await req(`/api/backtest-runs/${runId}/trades`, false);
  assert.equal(tradesRes.status, 200);
  const trades = (await tradesRes.json()) as { trades: { result: string; profitLoss: number }[] };
  assert.equal(trades.trades.length, createdRun.totalTrades, "one persisted trade row per simulated trade");
  for (const t of trades.trades) {
    assert.ok(["WIN", "LOSS", "BREAKEVEN", "TIMEOUT"].includes(t.result));
    assert.ok(Number.isFinite(t.profitLoss));
  }

  // Determinism sanity: identical config reproduces identical headline metrics.
  const res2 = await postJson("/api/backtest-runs", false, {
    strategyId: "trendContinuation",
    symbol: "EURUSD",
    timeframe: "M1",
    candleCount: 1000,
    minConfidence: 40,
  });
  assert.equal(res2.status, 200);
  const rerun = (await res2.json()) as RunDto;
  createdRunIds.push(rerun.id);
  assert.equal(rerun.totalTrades, createdRun.totalTrades, "identical config → identical trade count");
  assert.equal(rerun.netProfitLoss, createdRun.netProfitLoss, "identical config → identical P/L");
});

// ── (B) Profit Mission: create → pulse non-empty → approve a draft ───────────

interface MissionDto {
  id: number;
  userId: number;
  status: string;
  feasibility: { tier: string; canStart: boolean; isEstimate: boolean } | null;
}

let missionId: number;

test("POST /profit-missions creates a draft whose pulse has non-null feasibility", async () => {
  const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const createRes = await postJson("/api/profit-missions", true, {
    startingAmount: 1000,
    targetAmount: 1300,
    timeframeEnd: end,
    riskProfile: "balanced",
  });
  assert.equal(createRes.status, 201);
  const mission = (await createRes.json()) as MissionDto;
  assert.equal(mission.userId, userId);
  assert.equal(mission.status, "draft");
  missionId = mission.id;

  const pulseRes = await req(`/api/profit-missions/${missionId}/pulse`, true);
  assert.equal(pulseRes.status, 200);
  const pulse = (await pulseRes.json()) as MissionDto & Record<string, unknown>;
  assert.ok(Object.keys(pulse).length > 0, "pulse payload is non-empty");
  assert.ok(pulse.feasibility != null, "pulse carries a non-null feasibility read");
  assert.equal(typeof pulse.feasibility!.tier, "string");
  assert.equal(pulse.feasibility!.isEstimate, true, "feasibility stays estimate-labelled (honesty)");
});

test("an actionable proposal approves into an approved (never executed) draft", async () => {
  // The scan path depends on the live-feed environment, so seed the actionable
  // proposal deterministically (same pattern as the Phase 5 route suite) and
  // drive the REAL approve route over HTTP.
  await db.update(profitMissionsTable).set({ status: "running" }).where(eq(profitMissionsTable.id, missionId));
  const agent = await db
    .insert(missionAgentsTable)
    .values({ missionId, userId, agentKey: "SCALP_smoke", name: "Scalp", role: "scout", status: "active" })
    .returning();
  const edge = computeEdgeScore({
    direction: "BUY",
    components: {
      directionConviction: 90, setupQuality: 90, rewardToRisk: 90, entryQuality: 90,
      timingQuality: 90, orderFlow: 90, pattern: 90, trendline: 90, pivot: 90,
      agentTrust: 90, session: 90, symbolQuality: 90,
    },
    honesty: { feedStatus: "live", spread: "normal", timing: "fresh" },
  });
  await db.insert(missionProposalsTable).values({
    proposalId: "p-smoke",
    missionId,
    userId,
    missionAgentId: agent[0]!.id,
    agentKey: "SCALP_smoke",
    symbol: "EURUSD",
    timeframe: "H1",
    direction: "BUY",
    confidence: 60,
    status: "selected",
    expectedR: 2,
    entryPlanJson: { entryPrice: 1.085 },
    riskPlanJson: { stopLoss: 1.08, takeProfit: 1.095, expectedR: 2 },
    edgeJson: edge as unknown as Record<string, unknown>,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  });

  const res = await postJson(`/api/profit-missions/${missionId}/proposals/p-smoke/approve`, true, {});
  assert.equal(res.status, 200);
  const draft = (await res.json()) as { proposalId: string; status: string; effectiveStatus: string };
  assert.equal(draft.proposalId, "p-smoke");
  assert.equal(draft.status, "approved", "approval yields an approved draft");
  assert.notEqual(draft.status, "executed", "approval is NEVER execution");

  // The approved draft appears on the trade-drafts read.
  const listRes = await req(`/api/profit-missions/${missionId}/trade-drafts`, true);
  assert.equal(listRes.status, 200);
  const drafts = (await listRes.json()) as { proposalId: string; status: string }[];
  assert.equal(drafts.some((d) => d.proposalId === "p-smoke" && d.status === "approved"), true);
});
