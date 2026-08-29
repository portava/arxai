// Capability #36 — Incident Counterfactual Replay test suite.
//
// Proves, offline and deterministically, against the SYNTHETIC worked fixture
// (a constructed event sequence, labeled synthetic end-to-end):
//   1. The BASELINE parameterization reproduces the incident exactly
//      ($1,150 realized loss ≥ the $1,000 threshold; three dispatches; the
//      third delivery held UNKNOWN for 20 minutes).
//   2. Each alternative safeguard parameterization has its hand-checkable
//      counterfactual effect through the EXISTING pure engines:
//        - tight-staleness      blocks the stale-tick entry  → PREVENTED
//        - wide-idempotency     suppresses the duplicate      → PREVENTED
//        - tight-daily-loss-cap blocks the third entry        → PREVENTED
//        - tight-volume-cap     blocks the oversized entry    → PREVENTED
//        - tight-reconciliation shortens the UNKNOWN hold     → REDUCED
//   3. The runner is REPRODUCIBLE: identical fixture + params → identical
//      outcome, twice.
//   4. The journal draft is an advisory INFO event carrying the synthetic
//      label — evidence, never authority.
//   5. SOURCE PIN: the engine imports no venue adapter / pipeline / dispatch
//      entry and performs no DB write.
//
// SAFETY: offline. The dummy unroutable DATABASE_URL only satisfies
// @workspace/db's import-time env check (pulled in via phaseBConfig's
// buildLiveIdempotencyKey — the EXISTING idempotency engine); nothing here
// connects, queries, or dispatches.
//
// Run: pnpm --filter @workspace/api-server run test:incident-replay

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Dynamic imports AFTER the env assignment (static imports hoist; the engine
// transitively imports @workspace/db through phaseBConfig).
const { replayIncident, runIncidentCounterfactuals } = await import("../incidentReplay.js");
const {
  SYNTHETIC_STALE_DUPLICATE_OVERSIZE_FIXTURE: FIXTURE,
  SYNTHETIC_ALTERNATIVE_PARAMS: ALTERNATIVES,
} = await import("../incidentFixtures.js");
const { buildIncidentReplayAuditDraft } = await import("../incidentReplayJournal.js");

function alt(label: string) {
  const p = ALTERNATIVES.find((a) => a.label === label);
  assert.ok(p, `fixture is missing alternative "${label}"`);
  return p!;
}

// ── 1. Baseline reproduces the incident ─────────────────────────────────────

test("baseline parameters reproduce the synthetic incident exactly", async () => {
  const out = await replayIncident(FIXTURE, FIXTURE.baselineParams);
  assert.deepEqual(out.dispatched.map((d) => d.attemptId), ["A1", "A2", "A3"]);
  assert.equal(out.blocked.length, 0);
  assert.equal(out.realizedLossUsd, 1150);
  assert.equal(out.incidentOccurred, true);

  // The UNKNOWN third delivery: became unknown 10:04:10, detected by the
  // 5-minute sweep at 10:09:10, resolved 10:24:10 → 20 minutes of exposure
  // held on a position nobody could see.
  assert.equal(out.unknown.length, 1);
  const u = out.unknown[0]!;
  assert.equal(u.attemptId, "A3");
  assert.equal(u.becameUnknownAtIso, "2026-08-20T10:04:10.000Z");
  assert.equal(u.detectedBySweepAtIso, "2026-08-20T10:09:10.000Z");
  assert.equal(u.resolvedAtIso, "2026-08-20T10:24:10.000Z");
  assert.equal(u.exposureHeldMs, 20 * 60_000);
  assert.equal(out.severityScore, 1150 + 20);
});

// ── 2. Each alternative has its hand-checkable effect ───────────────────────

test("tight-staleness blocks the stale-tick entry through the REAL price sensor → PREVENTED", async () => {
  const out = await replayIncident(FIXTURE, alt("tight-staleness"));
  assert.deepEqual(out.blocked.map((b) => [b.attemptId, b.stage]), [["A1", "PRICE_STALENESS"]]);
  assert.ok(out.blocked[0]!.reasons.some((r) => /stale/i.test(r)));
  assert.equal(out.realizedLossUsd, 750);
  assert.equal(out.incidentOccurred, false);
});

test("wide-idempotency suppresses the duplicate through the REAL key builder → PREVENTED", async () => {
  const out = await replayIncident(FIXTURE, alt("wide-idempotency-window"));
  assert.deepEqual(out.blocked.map((b) => [b.attemptId, b.stage]), [["A2", "IDEMPOTENCY"]]);
  assert.equal(out.realizedLossUsd, 800);
  assert.equal(out.incidentOccurred, false);
});

test("tight-daily-loss-cap blocks the third entry through the REAL 23-gate evaluator → PREVENTED", async () => {
  const out = await replayIncident(FIXTURE, alt("tight-daily-loss-cap"));
  assert.deepEqual(out.blocked.map((b) => [b.attemptId, b.stage]), [["A3", "DISPATCH_GATE"]]);
  assert.ok(out.blocked[0]!.reasons.includes("DAILY_LOSS_LIMIT_REACHED"));
  assert.equal(out.realizedLossUsd, 750);
  assert.equal(out.incidentOccurred, false);
  // The blocked command never dispatched, so nothing went UNKNOWN.
  assert.equal(out.unknown.length, 0);
});

test("tight-volume-cap blocks the oversized entry through the REAL 23-gate evaluator → PREVENTED", async () => {
  const out = await replayIncident(FIXTURE, alt("tight-volume-cap"));
  assert.deepEqual(out.blocked.map((b) => [b.attemptId, b.stage]), [["A3", "DISPATCH_GATE"]]);
  assert.ok(out.blocked[0]!.reasons.includes("VOLUME_EXCEEDS_MAX_LIVE_LOT"));
  assert.equal(out.incidentOccurred, false);
});

test("tight-reconciliation-cadence shortens the UNKNOWN exposure hold → REDUCED (loss unchanged)", async () => {
  const out = await replayIncident(FIXTURE, alt("tight-reconciliation-cadence"));
  // Same dispatches, same loss — the incident still occurs...
  assert.equal(out.realizedLossUsd, 1150);
  assert.equal(out.incidentOccurred, true);
  // ...but the 60s sweep detects at 10:05:10 and resolves at 10:20:10 —
  // 16 minutes held instead of 20.
  const u = out.unknown[0]!;
  assert.equal(u.detectedBySweepAtIso, "2026-08-20T10:05:10.000Z");
  assert.equal(u.resolvedAtIso, "2026-08-20T10:20:10.000Z");
  assert.equal(u.exposureHeldMs, 16 * 60_000);
});

// ── The counterfactual matrix ───────────────────────────────────────────────

test("the matrix report names which configurations prevented and which reduced", async () => {
  const report = await runIncidentCounterfactuals(FIXTURE, ALTERNATIVES);
  assert.equal(report.synthetic, true);
  assert.equal(report.baseline.incidentOccurred, true);
  assert.deepEqual(report.preventedBy.sort(), [
    "tight-daily-loss-cap", "tight-staleness", "tight-volume-cap", "wide-idempotency-window",
  ]);
  assert.deepEqual(report.reducedBy, ["tight-reconciliation-cadence"]);
  for (const row of report.alternatives) {
    assert.ok(["PREVENTED", "REDUCED"].includes(row.verdict), `${row.params.label}: ${row.verdict}`);
  }
});

// ── 3. Reproducibility ──────────────────────────────────────────────────────

test("identical fixture + params produce the identical outcome (reproducible)", async () => {
  const a = await runIncidentCounterfactuals(FIXTURE, ALTERNATIVES);
  const b = await runIncidentCounterfactuals(FIXTURE, ALTERNATIVES);
  assert.deepEqual(a, b);
});

// ── 4. Journal draft ────────────────────────────────────────────────────────

test("the journal draft is advisory INFO evidence carrying the synthetic label", async () => {
  const report = await runIncidentCounterfactuals(FIXTURE, ALTERNATIVES);
  const draft = buildIncidentReplayAuditDraft(report);
  assert.equal(draft.eventType, "INCIDENT_COUNTERFACTUAL_REPLAY");
  assert.equal(draft.severity, "INFO");
  assert.equal(draft.payload["synthetic"], true);
  assert.equal(draft.payload["advisoryOnly"], true);
  assert.deepEqual(draft.payload["preventedBy"], report.preventedBy);
  assert.match(String(draft.payload["description"]), /SYNTHETIC/);
});

// ── 5. Source pin: replay only, no execution path, no DB write ──────────────

test("SOURCE PIN: the engine imports no venue adapter / pipeline / dispatch entry and never writes", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "incidentReplay.ts"), "utf8");
  const importLines = src.split("\n").filter((l) => /^\s*import\b|\bfrom\s+"/.test(l) && !l.trimStart().startsWith("//"));
  for (const forbidden of [
    "liveCommandPipeline", "guidedDispatchEntry", "derivGuidedBuy",
    "derivExecutionAdapter", "executionAdapter", "@workspace/db",
  ]) {
    assert.ok(
      !importLines.some((l) => l.includes(forbidden)),
      `forbidden import "${forbidden}" found in incidentReplay.ts`,
    );
  }
  assert.ok(!src.includes(".deliver("), "incidentReplay.ts must never call a venue deliver()");
  assert.ok(!/\bdb\.(insert|update|delete|execute)\b/.test(src), "incidentReplay.ts must never write the database");
});
