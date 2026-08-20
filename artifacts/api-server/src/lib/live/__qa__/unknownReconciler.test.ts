// R2 S3+S4+S5 — urgent UNKNOWN reconciliation, reconciliation freshness,
// and partial-fill non-terminality.
//
// Pins the audit-execution.md contracts closed by this slice:
//   S3 (G1)  — only EVIDENCE resolves an epistemic command: broker evidence
//              of the order ⇒ FILLED (reservation FULFILL); positive absence
//              after a FULL FRESH snapshot ⇒ FAILED (release); anything less
//              HOLDS — the command stays UNKNOWN and is only reported.
//   S4 (G5)  — the pure reconciliation-freshness predicate for the wave-5
//              dispatch pre-gate fails CLOSED on every degraded input.
//   S5 (G2)  — a partial fill is never coerced to a terminal complete:
//              mt5_commands "partial" and trade_action_requests
//              "partially_filled" stay outside the terminal sets, and a
//              PARTIAL_FILL execution event retains the evidence.
//
// Pure-unit + source-scan proofs only (established offline pattern):
// importing ../unknownReconciler.js transitively imports @workspace/db,
// whose module init throws when DATABASE_URL is unset. A dummy loopback URL
// satisfies the init; the pg Pool is lazy and NO query is ever issued.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/live/__qa__/unknownReconciler.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  UnknownCommandFacts,
  UnknownCommandEvidence,
} from "../unknownReconciler.js";

const {
  classifyUnknownCommand,
  reconciliationFreshnessVerdict,
  UNKNOWN_RECONCILE_DEFAULTS,
  RECONCILED_FILLED_EVENT,
  RECONCILED_ABSENT_EVENT,
  RECONCILIATION_ESCALATED_EVENT,
} = await import("../unknownReconciler.js");

const { isAllowedLiveTransition, settleReservationForStatus } =
  await import("../liveCommandPipeline.js");

const {
  mapCommandStatus,
  mapActionStatus,
  TERMINAL_COMMAND_STATUSES,
  TERMINAL_ACTION_STATUSES,
} = await import("../../mt5/executionReconciler.js");

const reconcilerSource = readFileSync(
  fileURLToPath(new URL("../unknownReconciler.ts", import.meta.url)),
  "utf8",
);
const executionReconcilerSource = readFileSync(
  fileURLToPath(new URL("../../mt5/executionReconciler.ts", import.meta.url)),
  "utf8",
);

// ── Fixtures ─────────────────────────────────────────────────────────────────

const T = (s: string) => new Date(s);
const NOW = T("2026-08-19T10:10:00Z");

function marketFacts(over: Partial<UnknownCommandFacts> = {}): UnknownCommandFacts {
  return {
    commandId: "cmd-unknown-1",
    commandType: "PLACE_LIVE_MARKET_ORDER",
    status: "LIVE_UNKNOWN",
    symbol: "EURUSD",
    side: "BUY",
    requestedVolume: 1.0,
    brokerTicket: null,
    sentToMt5At: T("2026-08-19T10:00:00Z"),
    pickedByEaAt: T("2026-08-19T10:00:05Z"),
    expiresAt: T("2026-08-19T10:01:00Z"),
    ...over,
  };
}

function evidence(over: Partial<UnknownCommandEvidence> = {}): UnknownCommandEvidence {
  return {
    positions: [],
    lateResults: [],
    lastCompleteSnapshotAt: null,
    evidenceComplete: true,
    ...over,
  };
}

const FRESH_SNAPSHOT = T("2026-08-19T10:06:00Z"); // after pickup+margin, 4 min old at NOW

// ── S3: classification matrix — fill evidence ────────────────────────────────

test("late EA result WITH a broker ticket resolves FILLED — for any command type", () => {
  const late = { reportedOutcome: "LIVE_FILLED", brokerTicket: "888111", fillPrice: 1.1, executedVolume: 1.0 };
  for (const commandType of [
    "PLACE_LIVE_MARKET_ORDER", "PLACE_LIVE_PENDING_ORDER", "CLOSE_LIVE_POSITION", "MODIFY_LIVE_SLTP",
  ]) {
    const v = classifyUnknownCommand(
      marketFacts({ commandType }),
      evidence({ lateResults: [late] }),
      { now: NOW },
    );
    assert.equal(v.action, "RESOLVE_FILLED", commandType);
    if (v.action === "RESOLVE_FILLED") {
      assert.equal(v.brokerTicket, "888111");
      assert.equal(v.evidence, "LATE_EA_RESULT_WITH_TICKET");
    }
  }
});

test("a position row LINKED to the command resolves FILLED", () => {
  const v = classifyUnknownCommand(
    marketFacts(),
    evidence({
      positions: [{
        brokerTicket: "777", sourceCommandId: "cmd-unknown-1",
        symbol: "EURUSD", side: "BUY", volume: 0.7,
        openedAt: T("2026-08-19T10:00:20Z"), closedAt: null,
      }],
    }),
    { now: NOW },
  );
  assert.equal(v.action, "RESOLVE_FILLED");
  if (v.action === "RESOLVE_FILLED") {
    assert.equal(v.evidence, "POSITION_LINKED_TO_COMMAND");
    assert.equal(v.brokerTicket, "777");
    assert.equal(v.executedVolume, 0.7, "executed volume comes from the position, never the request");
    assert.equal(v.fillPrice, null, "fill price is never fabricated from a snapshot");
  }
});

test("a position matching the command's recorded broker ticket resolves FILLED", () => {
  const v = classifyUnknownCommand(
    marketFacts({ brokerTicket: "654321" }),
    evidence({
      positions: [{
        brokerTicket: "654321", sourceCommandId: null,
        symbol: "EURUSD", side: "BUY", volume: 1.0,
        openedAt: T("2026-08-19T10:00:20Z"), closedAt: null,
      }],
    }),
    { now: NOW },
  );
  assert.equal(v.action, "RESOLVE_FILLED");
  if (v.action === "RESOLVE_FILLED") assert.equal(v.evidence, "POSITION_BROKER_TICKET_MATCH");
});

test("fill evidence beats an otherwise-perfect absence case (presence wins)", () => {
  const v = classifyUnknownCommand(
    marketFacts(),
    evidence({
      lastCompleteSnapshotAt: FRESH_SNAPSHOT,
      positions: [{
        brokerTicket: "777", sourceCommandId: "cmd-unknown-1",
        symbol: "EURUSD", side: "BUY", volume: 1.0,
        openedAt: T("2026-08-19T10:00:20Z"), closedAt: null,
      }],
    }),
    { now: NOW },
  );
  assert.equal(v.action, "RESOLVE_FILLED");
});

test("unreadable evidence blocks absence but NOT direct fill evidence", () => {
  const filled = classifyUnknownCommand(
    marketFacts(),
    evidence({
      evidenceComplete: false,
      positions: [{
        brokerTicket: "777", sourceCommandId: "cmd-unknown-1",
        symbol: "EURUSD", side: "BUY", volume: 1.0,
        openedAt: T("2026-08-19T10:00:20Z"), closedAt: null,
      }],
    }),
    { now: NOW },
  );
  assert.equal(filled.action, "RESOLVE_FILLED");

  const held = classifyUnknownCommand(
    marketFacts(),
    evidence({ evidenceComplete: false, lastCompleteSnapshotAt: FRESH_SNAPSHOT }),
    { now: NOW },
  );
  assert.equal(held.action, "HOLD");
  if (held.action === "HOLD") assert.equal(held.reason, "EVIDENCE_SOURCE_UNREADABLE");
});

// ── S3: classification matrix — holds ────────────────────────────────────────

test("a non-epistemic status is never classified", () => {
  for (const status of ["SENT_TO_MT5_LIVE", "LIVE_FILLED", "LIVE_EXPIRED", "LIVE_DRAFT"]) {
    const v = classifyUnknownCommand(marketFacts({ status }), evidence({ lastCompleteSnapshotAt: FRESH_SNAPSHOT }), { now: NOW });
    assert.equal(v.action, "HOLD", status);
    if (v.action === "HOLD") assert.equal(v.reason, "NOT_IN_EPISTEMIC_STATE");
  }
});

test("CLOSE/MODIFY unknowns hold for an operator — position evidence is inverted for them", () => {
  for (const commandType of ["CLOSE_LIVE_POSITION", "MODIFY_LIVE_SLTP"]) {
    // Even with a ticket-matching position AND a fresh snapshot: the target
    // position still standing suggests the close did NOT execute — the
    // entry-oriented rules must never auto-resolve it in either direction.
    const v = classifyUnknownCommand(
      marketFacts({ commandType, brokerTicket: "654321" }),
      evidence({
        lastCompleteSnapshotAt: FRESH_SNAPSHOT,
        positions: [{
          brokerTicket: "654321", sourceCommandId: null,
          symbol: "EURUSD", side: "BUY", volume: 1.0,
          openedAt: T("2026-08-19T09:00:00Z"), closedAt: null,
        }],
      }),
      { now: NOW },
    );
    assert.equal(v.action, "HOLD", commandType);
    if (v.action === "HOLD") assert.equal(v.reason, "NON_ENTRY_COMMAND_REQUIRES_OPERATOR");
  }
});

test("a retained ticketless 'success' is conflicting evidence — hold, never resolve", () => {
  const v = classifyUnknownCommand(
    marketFacts(),
    evidence({
      lastCompleteSnapshotAt: FRESH_SNAPSHOT,
      lateResults: [{ reportedOutcome: "LIVE_FILLED", brokerTicket: null, fillPrice: null, executedVolume: null }],
    }),
    { now: NOW },
  );
  assert.equal(v.action, "HOLD");
  if (v.action === "HOLD") assert.equal(v.reason, "CONFLICTING_EVIDENCE_TICKETLESS_SUCCESS");
});

test("an UNLINKED position matching symbol+side in the dispatch window is ambiguous — never auto-claimed", () => {
  const v = classifyUnknownCommand(
    marketFacts(),
    evidence({
      lastCompleteSnapshotAt: FRESH_SNAPSHOT,
      positions: [{
        brokerTicket: "999", sourceCommandId: null,
        symbol: "EURUSD", side: "BUY", volume: 0.5, // volume differs — still ambiguous (partial fills change volume)
        openedAt: T("2026-08-19T10:00:30Z"), closedAt: null,
      }],
    }),
    { now: NOW },
  );
  assert.equal(v.action, "HOLD");
  if (v.action === "HOLD") assert.equal(v.reason, "AMBIGUOUS_POSITION_MATCH");
});

test("an unlinked position OUTSIDE the dispatch window does not block absence", () => {
  const v = classifyUnknownCommand(
    marketFacts(),
    evidence({
      lastCompleteSnapshotAt: FRESH_SNAPSHOT,
      positions: [{
        brokerTicket: "111", sourceCommandId: null,
        symbol: "EURUSD", side: "BUY", volume: 1.0,
        openedAt: T("2026-08-19T08:00:00Z"), closedAt: null, // hours before dispatch
      }],
    }),
    { now: NOW },
  );
  assert.equal(v.action, "RESOLVE_ABSENT");
});

// ── S3: classification matrix — positive absence (the narrowest rule) ────────

test("absence: market entry + full fresh snapshot postdating pickup ⇒ RESOLVE_ABSENT", () => {
  const v = classifyUnknownCommand(marketFacts(), evidence({ lastCompleteSnapshotAt: FRESH_SNAPSHOT }), { now: NOW });
  assert.equal(v.action, "RESOLVE_ABSENT");
  if (v.action === "RESOLVE_ABSENT") assert.equal(v.evidence, "FRESH_COMPLETE_SNAPSHOT_WITHOUT_MATCH");
});

test("absence is never granted to a pending order — a resting order need not appear in a POSITION snapshot", () => {
  const v = classifyUnknownCommand(
    marketFacts({ commandType: "PLACE_LIVE_PENDING_ORDER" }),
    evidence({ lastCompleteSnapshotAt: FRESH_SNAPSHOT }),
    { now: NOW },
  );
  assert.equal(v.action, "HOLD");
  if (v.action === "HOLD") assert.equal(v.reason, "PENDING_ORDER_ABSENCE_UNPROVABLE");
});

test("absence requires a snapshot: none ⇒ hold", () => {
  const v = classifyUnknownCommand(marketFacts(), evidence(), { now: NOW });
  assert.equal(v.action, "HOLD");
  if (v.action === "HOLD") assert.equal(v.reason, "NO_COMPLETE_SNAPSHOT");
});

test("absence requires the snapshot to POSTDATE pickup by the settle margin", () => {
  // Snapshot 5s after pickup — inside the 30s settle margin: the order may
  // still have been settling at the broker when the sweep ran.
  const v = classifyUnknownCommand(
    marketFacts(),
    evidence({ lastCompleteSnapshotAt: T("2026-08-19T10:00:10Z") }),
    { now: T("2026-08-19T10:03:00Z") },
  );
  assert.equal(v.action, "HOLD");
  if (v.action === "HOLD") assert.equal(v.reason, "SNAPSHOT_PREDATES_COMMAND");
});

test("absence requires the snapshot to be FRESH", () => {
  const v = classifyUnknownCommand(
    marketFacts(),
    evidence({ lastCompleteSnapshotAt: T("2026-08-19T10:02:00Z") }), // 8 min old at NOW > 5 min default
    { now: NOW },
  );
  assert.equal(v.action, "HOLD");
  if (v.action === "HOLD") assert.equal(v.reason, "SNAPSHOT_STALE");
});

test("absence requires command timestamps — with none, hold", () => {
  const v = classifyUnknownCommand(
    marketFacts({ sentToMt5At: null, pickedByEaAt: null, expiresAt: null }),
    evidence({ lastCompleteSnapshotAt: FRESH_SNAPSHOT }),
    { now: NOW },
  );
  assert.equal(v.action, "HOLD");
  if (v.action === "HOLD") assert.equal(v.reason, "COMMAND_TIMESTAMPS_MISSING");
});

test("the defaults are conservative: 5-minute freshness, 30s settle margin", () => {
  assert.equal(UNKNOWN_RECONCILE_DEFAULTS.snapshotFreshnessMs, 5 * 60_000);
  assert.equal(UNKNOWN_RECONCILE_DEFAULTS.brokerSettleMarginMs, 30_000);
});

// ── S3: the resolutions ride the S1 envelope + pure settlement matrix ────────

test("the reconciler's resolutions are exactly envelope-legal", () => {
  assert.equal(isAllowedLiveTransition("LIVE_UNKNOWN", "LIVE_RECONCILIATION_REQUIRED"), true);
  assert.equal(isAllowedLiveTransition("LIVE_RECONCILIATION_REQUIRED", "LIVE_FILLED"), true);
  assert.equal(isAllowedLiveTransition("LIVE_RECONCILIATION_REQUIRED", "LIVE_FAILED"), true);
  // And the direct jump the runner must never take:
  assert.equal(isAllowedLiveTransition("LIVE_UNKNOWN", "LIVE_FILLED"), false);
  assert.equal(isAllowedLiveTransition("LIVE_UNKNOWN", "LIVE_FAILED"), false);
  // Settlement matrix agreement (same pure rule the pipeline uses):
  assert.equal(settleReservationForStatus("LIVE_FILLED"), "FULFILL");
  assert.equal(settleReservationForStatus("LIVE_FAILED"), "RELEASE");
});

test("runner source: every status write is a status-guarded CAS through the envelope (source pin)", () => {
  const fnStart = reconcilerSource.indexOf("async function applyReconciledTerminal");
  assert.ok(fnStart > 0);
  const fnBody = reconcilerSource.slice(fnStart);
  const escalationGuard = fnBody.indexOf('eq(arxLiveCommandsTable.status, "LIVE_UNKNOWN")');
  const resolutionGuard = fnBody.indexOf('eq(arxLiveCommandsTable.status, "LIVE_RECONCILIATION_REQUIRED")');
  assert.ok(escalationGuard > 0, "escalation CAS guards on LIVE_UNKNOWN");
  assert.ok(resolutionGuard > escalationGuard, "resolution CAS guards on LIVE_RECONCILIATION_REQUIRED, after escalation");
  assert.ok(fnBody.includes("isAllowedLiveTransition("), "legality is re-checked against the pure envelope predicate");
  assert.ok(fnBody.includes("settleReservationForStatus(terminal)"), "settlement goes through the S1 pure matrix");
});

// ── S3/S5: event emission pins ───────────────────────────────────────────────

test("reconciliation writes RECONCILED_FILLED / RECONCILED_ABSENT / escalation events (source pin)", () => {
  assert.equal(RECONCILED_FILLED_EVENT, "RECONCILED_FILLED");
  assert.equal(RECONCILED_ABSENT_EVENT, "RECONCILED_ABSENT");
  assert.equal(RECONCILIATION_ESCALATED_EVENT, "RECONCILIATION_ESCALATED");
  assert.ok(reconcilerSource.includes("RECONCILED_FILLED_EVENT, {"), "FILLED resolution emits its event");
  assert.ok(reconcilerSource.includes("RECONCILED_ABSENT_EVENT, {"), "ABSENT resolution emits its event");
  assert.ok(
    reconcilerSource.includes("eventType: RECONCILIATION_ESCALATED_EVENT"),
    "the UNKNOWN→RECONCILIATION_REQUIRED hop emits its event",
  );
  // The event writer reuses the S2 pure shaping — no second shaping law.
  assert.ok(reconcilerSource.includes("buildExecutionEventRow(input)"), "events are shaped by the S2 pure helper");
});

test("reconciliation never sends broker commands (source pin)", () => {
  for (const forbidden of ["enqueueBridgedMt5Command", "mt5CommandsTable", "OrderSend", "dispatchLiveCommand("]) {
    assert.ok(
      !reconcilerSource.includes(forbidden),
      `unknownReconciler must not reference ${forbidden}`,
    );
  }
});

test("a HOLD is report-only: the runner never updates a held command (source pin)", () => {
  const runnerStart = reconcilerSource.indexOf("export async function reconcileUnknownCommands");
  const runnerEnd = reconcilerSource.indexOf("// ── Evidence gathering");
  const runnerBody = reconcilerSource.slice(runnerStart, runnerEnd);
  const holdBranch = runnerBody.slice(
    runnerBody.indexOf('verdict.action === "HOLD"'),
    runnerBody.indexOf('verdict.action === "RESOLVE_FILLED"'),
  );
  assert.ok(holdBranch.length > 0, "the HOLD branch exists");
  assert.ok(!holdBranch.includes("db.update"), "HOLD performs no writes");
  assert.ok(holdBranch.includes("report.held.push"), "HOLD is reported");
});

// ── S4: reconciliation freshness predicate (fail-closed matrix) ──────────────

const CLEAN_RUN = {
  status: "COMPLETED",
  completedAt: T("2026-08-19T10:08:00Z"),
  positionsMatch: true,
  ordersMatch: true,
};

test("freshness: a completed, recent, fully-matched run passes", () => {
  const v = reconciliationFreshnessVerdict(CLEAN_RUN, 5 * 60_000, NOW);
  assert.deepEqual(v, { ok: true, reason: "FRESH_AND_CLEAN", ageMs: 120_000 });
});

test("freshness fails CLOSED on every degraded input", () => {
  const cases: Array<[string, Parameters<typeof reconciliationFreshnessVerdict>[0], number, string]> = [
    ["no run row", null, 300_000, "NO_RUN"],
    ["undefined run row", undefined, 300_000, "NO_RUN"],
    ["still RUNNING", { ...CLEAN_RUN, status: "RUNNING", completedAt: null }, 300_000, "RUN_NOT_COMPLETED"],
    ["FAILED run", { ...CLEAN_RUN, status: "FAILED" }, 300_000, "RUN_NOT_COMPLETED"],
    ["completed with null timestamp", { ...CLEAN_RUN, completedAt: null }, 300_000, "RUN_NOT_COMPLETED"],
    ["unparsable timestamp", { ...CLEAN_RUN, completedAt: "not-a-date" }, 300_000, "RUN_TIMESTAMP_INVALID"],
    ["future-dated timestamp", { ...CLEAN_RUN, completedAt: T("2026-08-19T11:00:00Z") }, 300_000, "RUN_TIMESTAMP_INVALID"],
    ["stale run", { ...CLEAN_RUN, completedAt: T("2026-08-19T09:00:00Z") }, 300_000, "RUN_STALE"],
    ["positions mismatch", { ...CLEAN_RUN, positionsMatch: false }, 300_000, "MISMATCH"],
    ["orders mismatch", { ...CLEAN_RUN, ordersMatch: false }, 300_000, "MISMATCH"],
    ["positions unverified", { ...CLEAN_RUN, positionsMatch: null }, 300_000, "MATCH_UNVERIFIED"],
    ["orders unverified", { ...CLEAN_RUN, ordersMatch: null }, 300_000, "MATCH_UNVERIFIED"],
    ["zero maxAge", CLEAN_RUN, 0, "INVALID_MAX_AGE"],
    ["negative maxAge", CLEAN_RUN, -1, "INVALID_MAX_AGE"],
    ["NaN maxAge", CLEAN_RUN, Number.NaN, "INVALID_MAX_AGE"],
  ];
  for (const [label, row, maxAge, reason] of cases) {
    const v = reconciliationFreshnessVerdict(row, maxAge, NOW);
    assert.equal(v.ok, false, label);
    assert.equal(v.reason, reason, label);
  }
});

test("freshness: a verified mismatch outranks an unverified sibling", () => {
  const v = reconciliationFreshnessVerdict(
    { ...CLEAN_RUN, positionsMatch: false, ordersMatch: null }, 300_000, NOW,
  );
  assert.equal(v.reason, "MISMATCH");
});

test("freshness accepts ISO-string timestamps (raw-SQL reads)", () => {
  const v = reconciliationFreshnessVerdict(
    { ...CLEAN_RUN, completedAt: "2026-08-19T10:08:00Z" }, 300_000, NOW,
  );
  assert.equal(v.ok, true);
});

test("the reconciliation_runs schema carries the spec §7 shape (source pin)", () => {
  const schemaSource = readFileSync(
    fileURLToPath(new URL("../../../../../../lib/db/src/schema/reconciliationRuns.ts", import.meta.url)),
    "utf8",
  );
  for (const marker of [
    'text("scope")', 'integer("bridge_connection_id")', 'integer("user_id")',
    'text("status")', 'boolean("positions_match")', 'boolean("orders_match")',
    'jsonb("mismatch_summary")', 'timestamp("started_at"', 'timestamp("completed_at"',
  ]) {
    assert.ok(schemaSource.includes(marker), `reconciliation_runs missing ${marker}`);
  }
});

// ── S5: partial fills are non-terminal (audit G2, red-fail test 5) ───────────

test("mapCommandStatus: partial is NOT completed; the rest is unchanged", () => {
  assert.equal(mapCommandStatus("partial"), "partial");
  assert.equal(mapCommandStatus("executed"), "completed");
  assert.equal(mapCommandStatus("rejected"), "failed");
  assert.equal(mapCommandStatus("failed"), "failed");
  assert.equal(mapCommandStatus("pending"), "sent");
});

test("mapActionStatus: partial is NOT executed; the rest is unchanged", () => {
  assert.equal(mapActionStatus("partial"), "partially_filled");
  assert.equal(mapActionStatus("executed"), "executed");
  assert.equal(mapActionStatus("rejected"), "rejected");
  assert.equal(mapActionStatus("failed"), "failed");
  assert.equal(mapActionStatus("pending"), "sent_to_mt5");
});

test("the partial literals stay OUTSIDE the terminal sets — a later full fill can still terminalize", () => {
  assert.equal(TERMINAL_COMMAND_STATUSES.has("partial"), false);
  assert.equal(TERMINAL_ACTION_STATUSES.has("partially_filled"), false);
  // The prior terminal sets are unchanged (monotonicity guards intact).
  for (const s of ["completed", "failed", "expired", "cancelled"]) {
    assert.equal(TERMINAL_COMMAND_STATUSES.has(s), true, s);
  }
  for (const s of ["executed", "rejected", "failed", "expired", "cancelled"]) {
    assert.equal(TERMINAL_ACTION_STATUSES.has(s), true, s);
  }
});

test("a partial never stamps completedAt/failedAt (source pin: terminal-derived stamps)", () => {
  const fnStart = executionReconcilerSource.indexOf("export async function reconcileExecutionResult");
  const fnBody = executionReconcilerSource.slice(fnStart);
  assert.ok(
    fnBody.includes("completedAt: isTerminal && !isFailed ? now : command.completedAt"),
    "completedAt derives from isTerminal — non-terminal partial cannot stamp it",
  );
  assert.ok(
    fnBody.includes("const isTerminal = TERMINAL_COMMAND_STATUSES.has(newCommandStatus)"),
    "isTerminal derives from the exported terminal set",
  );
});

test("a partial fill writes a PARTIAL_FILL execution event with executed-vs-requested volumes (source pin)", () => {
  assert.ok(
    executionReconcilerSource.includes('if (result.status === "partial")'),
    "the partial branch exists in reconcileExecutionResult",
  );
  const helperStart = executionReconcilerSource.indexOf("async function recordPartialFillEvidence");
  assert.ok(helperStart > 0, "the partial-fill evidence helper exists");
  const helper = executionReconcilerSource.slice(helperStart);
  assert.ok(helper.includes('eventType: "PARTIAL_FILL"'), "event type is PARTIAL_FILL");
  assert.ok(helper.includes("requestedVolume"), "requested volume is retained");
  assert.ok(helper.includes("executedVolume"), "executed volume is retained");
  assert.ok(helper.includes("remainingVolume"), "remaining volume is retained");
  assert.ok(
    helper.includes("appendExecutionEvidence"),
    "the shared S2/S3 event writer is reused (no second SQL writer)",
  );
  // Honesty: no anchor, no event — never a fabricated command_id.
  assert.ok(
    helper.includes("partial_fill_on_legacy_command_no_arx_anchor_event_skipped"),
    "legacy (non-bridged) partials skip the event instead of fabricating an anchor",
  );
});

test("the canonical demo mapping forward-declares DEMO_PARTIALLY_FILLED (read layer is ready)", async () => {
  const { executionState } = await import("@workspace/domain");
  const got = executionState.fromMt5DemoStatus("DEMO_PARTIALLY_FILLED");
  assert.equal(got.state, "partially_filled");
  assert.equal(got.lossy, false);
  // And the legacy vocabulary's own partial literal still maps losslessly.
  const legacy = executionState.fromMt5CommandStatus("partial");
  assert.equal(legacy.state, "partially_filled");
  assert.equal(legacy.lossy, false);
});
