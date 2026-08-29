// Capability #35 — As-Of Reconstruction test suite.
//
// Proves, offline and deterministically, against the PURE assembler:
//   1. AS-OF SELECTION: the latest record at/before t wins per section, with
//      the boundary instant included (≤, matching the bitemporal
//      PointInTimeReader convention).
//   2. NO LOOKAHEAD: rows known only after t NEVER contribute — even when a
//      sloppy caller forgets to pre-filter (the core re-filters).
//   3. HONEST NULLS: an unreadable source degrades ONLY its section to
//      { available: false, reason }; a source with no rows before t says so
//      rather than assuming a default; the non-bitemporal sources
//      (safety_core, position field values, model approval flags) declare
//      their limits in basis/caveat text instead of passing current values
//      off as historical.
//   4. PENDING-ORDER RECONSTRUCTION: created ≤ t and not provably terminal
//      by t is PENDING_AS_OF; terminal-now-with-no-timestamp is
//      INDETERMINATE, never guessed either way.
//   5. HISTORY WALKS: probation/promotion state as-of comes from the
//      append-only historyJson, latest entry ≤ t.
//   6. READ-ONLY PIN: the IO wrapper contains no write statement and the
//      admin route rejects future timestamps.
//
// Run: pnpm --filter @workspace/api-server run test:as-of-reconstruction

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  assembleAsOfView,
  type RawAsOfSources,
} from "../asOfCore.js";

const T = Date.parse("2026-08-20T12:00:00Z");
const BEFORE = (ms: number) => new Date(T - ms);
const AFTER = (ms: number) => new Date(T + ms);

function emptySources(): RawAsOfSources {
  return {
    stateTransitions: { ok: true, rows: [] },
    vaultEvents: { ok: true, rows: [] },
    modelVersions: { ok: true, rows: [] },
    healthChecks: { ok: true, rows: [] },
    commands: { ok: true, rows: [] },
    positions: { ok: true, rows: [] },
    probations: { ok: true, rows: [] },
    policyPromotions: { ok: true, rows: [] },
  };
}

// ── 1. As-of selection + boundary ───────────────────────────────────────────

test("global state: latest transition at/before t wins; the boundary instant is included", () => {
  const raw = emptySources();
  raw.stateTransitions = {
    ok: true,
    rows: [
      { fromState: "NORMAL", toState: "HIGH_VOLATILITY", createdAt: BEFORE(3600_000), generatedAtIso: "" },
      { fromState: "HIGH_VOLATILITY", toState: "DEGRADED_MODE", createdAt: new Date(T), generatedAtIso: "" }, // exactly t
      { fromState: "DEGRADED_MODE", toState: "NORMAL", createdAt: AFTER(1), generatedAtIso: "" },
    ],
  };
  const view = assembleAsOfView(T, raw);
  assert.equal(view.globalState.available, true);
  if (view.globalState.available) {
    assert.equal(view.globalState.data.state, "DEGRADED_MODE", "the transition AT the boundary instant is knowledge at t");
  }
});

test("health: latest check ≤ t with its age at t (a stale check is reported stale, not current)", () => {
  const raw = emptySources();
  raw.healthChecks = {
    ok: true,
    rows: [
      { healthCheckId: "old", overallStatus: "HEALTHY", liveTradingStatus: "DISABLED", mode: "PAPER_ONLY", createdAt: BEFORE(7200_000) },
      { healthCheckId: "newer", overallStatus: "DEGRADED", liveTradingStatus: "DISABLED", mode: "PAPER_ONLY", createdAt: BEFORE(1800_000) },
    ],
  };
  const view = assembleAsOfView(T, raw);
  assert.equal(view.health.available, true);
  if (view.health.available) {
    assert.equal(view.health.data.healthCheckId, "newer");
    assert.equal(view.health.data.ageMsAtAsOf, 1800_000);
  }
});

// ── 2. No lookahead ─────────────────────────────────────────────────────────

test("NO LOOKAHEAD: rows known only after t never contribute, even unfiltered by the caller", () => {
  const raw = emptySources();
  raw.stateTransitions = {
    ok: true,
    rows: [{ fromState: "NORMAL", toState: "LOCKDOWN", createdAt: AFTER(60_000), generatedAtIso: "" }],
  };
  raw.healthChecks = {
    ok: true,
    rows: [{ healthCheckId: "future", overallStatus: "FAILED", liveTradingStatus: "DISABLED", mode: "PAPER_ONLY", createdAt: AFTER(1) }],
  };
  raw.positions = {
    ok: true,
    rows: [{ id: 1, userId: 1, symbol: "EURUSD", direction: "BUY", lotSize: 0.1, stopLoss: 1.0, takeProfit: null, status: "OPEN", openedAt: AFTER(5000), closedAt: null, lastSyncedAt: null }],
  };
  raw.commands = {
    ok: true,
    rows: [{ id: 9, userId: 1, action: "OPEN", symbol: "EURUSD", status: "PENDING", createdAt: AFTER(5000), completedAt: null, failedAt: null, expiresAt: null, updatedAt: null }],
  };
  const view = assembleAsOfView(T, raw);
  assert.equal(view.globalState.available, false, "a future transition must not leak into the as-of state");
  assert.equal(view.health.available, false);
  if (view.openPositions.available) assert.equal(view.openPositions.data.positions.length, 0);
  if (view.pendingOrders.available) assert.equal(view.pendingOrders.data.pending.length, 0);
});

// ── 3. Honest nulls ─────────────────────────────────────────────────────────

test("an unreadable source degrades ONLY its section; the others still assemble", () => {
  const raw = emptySources();
  raw.vaultEvents = { ok: false, reason: "relation does not exist" };
  raw.healthChecks = {
    ok: true,
    rows: [{ healthCheckId: "h", overallStatus: "HEALTHY", liveTradingStatus: "DISABLED", mode: "PAPER_ONLY", createdAt: BEFORE(1000) }],
  };
  const view = assembleAsOfView(T, raw);
  assert.equal(view.killSwitchAndMode.available, false);
  if (!view.killSwitchAndMode.available) assert.ok(view.killSwitchAndMode.reason.includes("relation does not exist"));
  assert.equal(view.health.available, true);
});

test("no rows before t = honest unavailable with a reason, never an assumed default", () => {
  const view = assembleAsOfView(T, emptySources());
  assert.equal(view.globalState.available, false);
  if (!view.globalState.available) {
    assert.ok(view.globalState.reason.includes("not assumed NORMAL"), "the reason must say the default is NOT assumed");
  }
  assert.equal(view.killSwitchAndMode.available, false);
  if (!view.killSwitchAndMode.available) {
    assert.ok(view.killSwitchAndMode.reason.includes("safety_core"), "must explain WHY the mutable single row is not reconstructible");
  }
});

test("non-bitemporal sources declare their limits: model flags are liveAllowedNow; position fields are current-time", () => {
  const raw = emptySources();
  raw.modelVersions = {
    ok: true,
    rows: [
      { versionId: "v1", versionName: "old", changeType: "scanner_scoring", liveAllowed: false, createdAt: BEFORE(9000_000) },
      { versionId: "v2", versionName: "new", changeType: "scanner_scoring", liveAllowed: true, createdAt: BEFORE(1000) },
      { versionId: "v3", versionName: "future", changeType: "scanner_scoring", liveAllowed: true, createdAt: AFTER(1000) },
    ],
  };
  raw.positions = {
    ok: true,
    rows: [{ id: 5, userId: 2, symbol: "XAUUSD", direction: "SELL", lotSize: 0.2, stopLoss: null, takeProfit: null, status: "OPEN", openedAt: BEFORE(60_000), closedAt: null, lastSyncedAt: null }],
  };
  const view = assembleAsOfView(T, raw);
  assert.equal(view.modelVersions.available, true);
  if (view.modelVersions.available) {
    assert.equal(view.modelVersions.data.latestPerChangeType.length, 1);
    assert.equal(view.modelVersions.data.latestPerChangeType[0]!.versionId, "v2", "latest CREATED ≤ t per changeType; the future version excluded");
    assert.ok(view.modelVersions.data.caveat.includes("not reconstructible"), "approval-flag caveat must be declared");
  }
  assert.equal(view.openPositions.available, true);
  if (view.openPositions.available) {
    assert.ok(view.openPositions.data.caveat.includes("CURRENT-time"), "field-value caveat must be declared");
    assert.equal(view.openPositions.data.positions[0]!.hadStopLossNow, false);
  }
});

// ── 4. Pending orders ───────────────────────────────────────────────────────

test("pending-order reconstruction: PENDING_AS_OF vs terminal-before-t vs INDETERMINATE", () => {
  const raw = emptySources();
  raw.commands = {
    ok: true,
    rows: [
      // Still pending now, created before t → pending as of t.
      { id: 1, userId: 1, action: "OPEN", symbol: "EURUSD", status: "PENDING", createdAt: BEFORE(60_000), completedAt: null, failedAt: null, expiresAt: null, updatedAt: null },
      // Completed AFTER t → was still pending at t.
      { id: 2, userId: 1, action: "OPEN", symbol: "EURUSD", status: "completed", createdAt: BEFORE(60_000), completedAt: AFTER(30_000), failedAt: null, expiresAt: null, updatedAt: null },
      // Completed BEFORE t → not pending at t.
      { id: 3, userId: 1, action: "OPEN", symbol: "EURUSD", status: "completed", createdAt: BEFORE(60_000), completedAt: BEFORE(30_000), failedAt: null, expiresAt: null, updatedAt: null },
      // Terminal NOW but no terminal timestamp → INDETERMINATE, never guessed.
      { id: 4, userId: 1, action: "OPEN", symbol: "EURUSD", status: "expired", createdAt: BEFORE(60_000), completedAt: null, failedAt: null, expiresAt: null, updatedAt: null },
      // Provably expired by t → not pending.
      { id: 5, userId: 1, action: "OPEN", symbol: "EURUSD", status: "PENDING", createdAt: BEFORE(60_000), completedAt: null, failedAt: null, expiresAt: BEFORE(10_000), updatedAt: null },
    ],
  };
  const view = assembleAsOfView(T, raw);
  assert.equal(view.pendingOrders.available, true);
  if (!view.pendingOrders.available) return;
  const byId = new Map(view.pendingOrders.data.pending.map((p) => [p.id, p]));
  assert.equal(byId.get(1)?.verdict, "PENDING_AS_OF");
  assert.equal(byId.get(2)?.verdict, "PENDING_AS_OF");
  assert.equal(byId.has(3), false);
  assert.equal(byId.get(4)?.verdict, "INDETERMINATE");
  assert.equal(byId.has(5), false);
  assert.equal(view.pendingOrders.data.indeterminate, 1);
});

// ── 5. History walks ────────────────────────────────────────────────────────

test("probation + promotion as-of come from the append-only history, latest entry ≤ t", () => {
  const raw = emptySources();
  raw.probations = {
    ok: true,
    rows: [{
      status: "active",
      stageOrStatus: "REDUCED_SIZE", // current stage — must NOT be used for as-of
      historyJson: [
        { at: BEFORE(7200_000).toISOString(), fromStage: null, toStage: "PAPER_ONLY", direction: "arm" },
        { at: BEFORE(3600_000).toISOString(), fromStage: "PAPER_ONLY", toStage: "A_PLUS_ONLY", direction: "advance" },
        { at: AFTER(3600_000).toISOString(), fromStage: "A_PLUS_ONLY", toStage: "REDUCED_SIZE", direction: "advance" },
      ],
      createdAt: BEFORE(7200_000),
    }],
  };
  raw.policyPromotions = {
    ok: true,
    rows: [{
      status: "ENABLED",
      stageOrStatus: "ENABLED",
      historyJson: [
        { at: BEFORE(1800_000).toISOString(), fromStatus: null, toStatus: "PRESS_UNLOCKED", kind: "auto" },
        { at: AFTER(60_000).toISOString(), fromStatus: "PRESS_UNLOCKED", toStatus: "ENABLED", kind: "owner_press" },
      ],
      createdAt: BEFORE(1800_000),
    }],
  };
  const view = assembleAsOfView(T, raw);
  assert.equal(view.recoveryProbation.available, true);
  if (view.recoveryProbation.available && "stage" in view.recoveryProbation.data) {
    assert.equal(view.recoveryProbation.data.stage, "A_PLUS_ONLY", "as-of stage comes from history, not the mutated current row");
  } else {
    assert.fail("expected a probation stage");
  }
  assert.equal(view.executionPolicyPromotion.available, true);
  if (view.executionPolicyPromotion.available && "status" in view.executionPolicyPromotion.data) {
    assert.equal(view.executionPolicyPromotion.data.status, "PRESS_UNLOCKED", "the future owner press must not leak backward");
  } else {
    assert.fail("expected a promotion status");
  }
});

test("no history before t is declared, not defaulted", () => {
  const view = assembleAsOfView(T, emptySources());
  assert.equal(view.recoveryProbation.available, true);
  if (view.recoveryProbation.available) {
    assert.ok("neverArmedBefore" in view.recoveryProbation.data);
  }
});

// ── 6. Read-only pins ───────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("the IO wrapper is SELECT-only (no insert/update/delete on any table object)", () => {
  const src = readFileSync(path.resolve(HERE, "../asOfReconstruction.ts"), "utf8");
  assert.ok(!/db\s*\.\s*(insert|update|delete|execute)/.test(src), "as-of reconstruction must never write");
  assert.ok(src.includes("db.select") || src.includes(".select("), "expected drizzle selects");
});

test("the admin route rejects future timestamps and unparseable input", () => {
  const src = readFileSync(path.resolve(HERE, "../../../routes/adminResilience.ts"), "utf8");
  assert.ok(src.includes("TIMESTAMP_IN_FUTURE"));
  assert.ok(src.includes("TIMESTAMP_UNPARSEABLE"));
  assert.ok(src.includes("reconstructSystemAsOf"));
});

test("the CLI exists, is read-only, and refuses the future", () => {
  const src = readFileSync(path.resolve(HERE, "../../../scripts/asOfCli.ts"), "utf8");
  assert.ok(src.includes("reconstructSystemAsOf"));
  assert.ok(src.includes("historical only"));
  assert.ok(!/db\s*\.\s*(insert|update|delete)/.test(src));
});
