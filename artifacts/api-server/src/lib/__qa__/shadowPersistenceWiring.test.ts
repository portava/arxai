// Shadow persistence wiring — offline proofs (R7 step 2).
//
// Proves the audit gap (intel-learning.md §1.3/§1.4) cannot silently reopen:
// lib/shadowPersistence.ts used to be an orphan at the repo root whose
// relative imports could never resolve, so shadow_predictions had ZERO
// writers and the learning-version gates were deadlocked on
// shadowSampleSize = 0 forever. These tests pin:
//   1. the module now lives in api-server/src/lib and imports cleanly;
//   2. the repo-root orphan is gone (a re-introduced copy fails CI);
//   3. shadowMode.ts actually calls persistShadowDecision /
//      updateShadowOutcome (source-text proof — no DB needed);
//   4. HONESTY: rows shaped from the scanner loop carry the
//      SYNTHETIC_SIMULATOR source label, because the candle feed is the
//      synthetic marketSimulator until the real-data swap (later R7 step).
//
// shadowPersistence resolves the @workspace/db handle LAZILY (module init of
// that package throws when DATABASE_URL is unset), so importing it — and
// shadowMode, and every route importing shadowMode — needs no database. A
// subprocess test below pins that with DATABASE_URL fully absent. The dummy
// unroutable URL here is defense-in-depth for this process; NO query is ever
// issued — only the pure shape* helpers are exercised.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/__qa__/shadowPersistenceWiring.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ShadowDecision } from "../shadowMode.js";

const {
  SYNTHETIC_SIMULATOR_SOURCE,
  shapeShadowDecisionRow,
  shapeShadowOutcomeUpdate,
  persistShadowDecision,
  updateShadowOutcome,
  persistRubyChatPrediction,
} = await import("../shadowPersistence.js");

function fixtureDecision(overrides: Partial<ShadowDecision> = {}): ShadowDecision {
  return {
    id: "sh_qa_fixture_000001",
    ts: "2026-08-19T12:00:00.000Z",
    symbol: "XAUUSD",
    tf: "M15",
    strategy: "Conservative Pullback",
    marketCondition: "TRENDING",
    action: "BUY",
    entry: 2400.5,
    sl: 2395.5,
    tp: 2410.5,
    confidence: 72,
    opportunity: 72,
    sniper: 67,
    grade: 7,
    riskGovernor: { approved: true, level: "LOW", hardBlocks: [], warnings: ["QA_FIXTURE"] },
    reason: "qa fixture — not a market observation",
    reasonToAvoid: "",
    status: "SHADOW_TRACKING_OUTCOME",
    expiresAt: "2026-08-19T12:05:00.000Z",
    dataSource: "SHADOW",
    ...overrides,
  };
}

// ── 1. Import-resolution smoke from the new home ─────────────────────────────
test("module imports cleanly from api-server/src/lib and exports the wiring surface", () => {
  assert.equal(typeof persistShadowDecision, "function");
  assert.equal(typeof updateShadowOutcome, "function");
  assert.equal(typeof persistRubyChatPrediction, "function");
  assert.equal(typeof shapeShadowDecisionRow, "function");
  assert.equal(typeof shapeShadowOutcomeUpdate, "function");
  assert.equal(SYNTHETIC_SIMULATOR_SOURCE, "SYNTHETIC_SIMULATOR");
});

// The persistence wiring must not ADD an eager @workspace/db import edge to
// shadowMode's graph: shadowPersistence resolves the db handle lazily, so
// importing IT needs no database. (shadowMode's own graph already required
// DATABASE_URL before this wiring, via riskGovernor2/marketScanner — a
// pre-existing edge outside this module's contract.) Runs as a subprocess
// precisely so DATABASE_URL can be truly ABSENT.
test("shadowPersistence imports without any DATABASE_URL — db handle is lazy", () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const moduleUrl = pathToFileURL(
    fileURLToPath(new URL("../shadowPersistence.ts", import.meta.url)),
  ).href;
  const r = spawnSync(
    process.execPath,
    [
      "--import", "tsx", "--input-type=module",
      "-e", `await import(${JSON.stringify(moduleUrl)}); process.exit(0);`,
    ],
    {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      env,
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  assert.equal(r.status, 0, `import failed offline:\n${r.stderr}`);
});

// ── 2. The repo-root orphan stays deleted ────────────────────────────────────
test("repo-root lib/shadowPersistence.ts (the dead orphan) does not exist", () => {
  const repoRootOrphan = fileURLToPath(
    new URL("../../../../../lib/shadowPersistence.ts", import.meta.url),
  );
  // Sanity: the same walk-up locates a real repo-root lib package, proving the
  // path arithmetic points at the repo root and not somewhere vacuous.
  const repoRootDbPkg = fileURLToPath(
    new URL("../../../../../lib/db/package.json", import.meta.url),
  );
  assert.equal(existsSync(repoRootDbPkg), true, "path sanity check broke — repo layout moved");
  assert.equal(existsSync(repoRootOrphan), false, "orphan lib/shadowPersistence.ts was re-introduced");
});

// ── 3. Source-text proof: shadowMode.ts is actually wired ────────────────────
test("shadowMode.ts calls persistShadowDecision with the SYNTHETIC label and syncs outcomes", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../shadowMode.ts", import.meta.url)),
    "utf8",
  );
  assert.match(src, /from "\.\/shadowPersistence\.js"/, "shadowMode must import the persistence layer");
  assert.match(
    src,
    /persistShadowDecision\(d, SYNTHETIC_SIMULATOR_SOURCE\)/,
    "new decisions must be persisted with the synthetic-source label",
  );
  assert.match(src, /updateShadowOutcome\(d\)/, "resolved outcomes must be synced to the durable row");
  // The outcome sync must live inside trackOutcomes' resolution path.
  const trackOutcomesBody = src.slice(src.indexOf("function trackOutcomes"), src.indexOf("export function startShadowMode"));
  assert.match(trackOutcomesBody, /persistOutcome\(d\)/, "trackOutcomes must persist terminal transitions");
});

// ── 4. Pure row shaping + HONESTY labeling ───────────────────────────────────
test("shapeShadowDecisionRow maps the decision and labels the source SYNTHETIC_SIMULATOR", () => {
  const d = fixtureDecision();
  const row = shapeShadowDecisionRow(d, SYNTHETIC_SIMULATOR_SOURCE);

  assert.equal(row.source, "SYNTHETIC_SIMULATOR");
  assert.equal(row.shadowId, d.id);
  assert.equal(row.userId, null);
  assert.equal(row.symbol, "XAUUSD");
  assert.equal(row.timeframe, "M15");
  assert.equal(row.strategy, "Conservative Pullback");
  assert.equal(row.action, "BUY");
  assert.equal(row.entryPrice, 2400.5);
  assert.equal(row.stopLoss, 2395.5);
  assert.equal(row.takeProfit, 2410.5);
  assert.equal(row.confidence, 72);
  assert.equal(row.status, "SHADOW_TRACKING_OUTCOME");
  assert.equal(row.rgApproved, true);
  assert.deepEqual(JSON.parse(row.rgHardBlocks as string), []);
  assert.deepEqual(row.predictedAt, new Date("2026-08-19T12:00:00.000Z"));
  assert.deepEqual(row.expiresAt, new Date("2026-08-19T12:05:00.000Z"));
  assert.ok(
    ["asian", "london", "overlap", "newyork"].includes(row.sessionLabel as string),
    `sessionLabel must be a known session, got ${String(row.sessionLabel)}`,
  );
});

test("the synthetic label can never collide with the real-evidence source taxonomy", () => {
  assert.notEqual(SYNTHETIC_SIMULATOR_SOURCE, "scanner");
  assert.notEqual(SYNTHETIC_SIMULATOR_SOURCE, "ruby_chat");
  assert.match(SYNTHETIC_SIMULATOR_SOURCE, /SYNTHETIC/);
});

// ── 5. Outcome shaping: terminal-only, honest pnlR handling ──────────────────
test("shapeShadowOutcomeUpdate returns null for every non-terminal status", () => {
  for (const status of [
    "SHADOW_OBSERVATION", "SHADOW_TRADE_IDEA", "SHADOW_WAIT",
    "SHADOW_REJECTED", "SHADOW_TRACKING_OUTCOME",
  ] as const) {
    assert.equal(shapeShadowOutcomeUpdate(fixtureDecision({ status })), null, status);
  }
});

test("shapeShadowOutcomeUpdate syncs terminal statuses with pnlR and resolvedAt", () => {
  const win = shapeShadowOutcomeUpdate(fixtureDecision({
    status: "SHADOW_WIN", pnlR: 2, outcomeAt: "2026-08-19T12:03:00.000Z",
  }));
  assert.ok(win);
  assert.equal(win.status, "SHADOW_WIN");
  assert.equal(win.pnlR, 2);
  assert.deepEqual(win.resolvedAt, new Date("2026-08-19T12:03:00.000Z"));

  // Missing pnlR must persist as null — never fabricated to 0.
  const expired = shapeShadowOutcomeUpdate(fixtureDecision({
    status: "SHADOW_EXPIRED", outcomeAt: "2026-08-19T12:06:00.000Z",
  }));
  assert.ok(expired);
  assert.equal(expired.pnlR, null);
});
