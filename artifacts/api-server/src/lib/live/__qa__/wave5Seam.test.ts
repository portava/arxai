// Wave-5 — R2-S7 execution-adapter seam, R3 slice 3 reservation atomicity,
// and the R2-S4 reconciliation-freshness entry pre-gate (flag-staged).
//
// Offline proofs in four groups:
//   1. SEAM — Mt5EaBridgeAdapter is a pure pass-through around the pipeline's
//      unchanged enqueueBridgedMt5Command (byte-equivalence pins: interface
//      consumption, no direct call remains, CAS-before-deliver and
//      mirror-failure → mark-failed source order preserved).
//   2. ATOMICITY — the per-user allocation headroom check + reservation write
//      run under a pg advisory lock keyed by userId (presence + order pins),
//      and the pure headroom predicate matches computeAvailableBalance.
//   3. RESERVED RISK — computeReservedRiskUsd matrix over the shared
//      in-flight-status / entry-type vocabulary at the shared margin proxy.
//   4. FRESHNESS GATE — flag parse (default OFF), max-age parse, and the
//      verdict → block-reason mapping composed with the real
//      reconciliationFreshnessVerdict (fresh-pass / stale / mismatch /
//      no-run fail-closed), plus dispatch source-order pins.
//
// Importing ../liveCommandPipeline.js transitively imports @workspace/db,
// whose module init throws when DATABASE_URL is unset. A dummy loopback URL
// satisfies the init; the pg Pool is lazy and NO query is ever issued by
// these tests. Structure mirrors preGateWave4.test.ts /
// emergencyKillSwitchPreGate.test.ts.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/live/__qa__/wave5Seam.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const {
  RECONCILIATION_FRESHNESS_GATE_ENV,
  RECONCILIATION_MAX_AGE_ENV,
  DEFAULT_RECONCILIATION_MAX_AGE_MS,
  RECONCILIATION_STALE_BLOCK_REASON,
  RECONCILIATION_MISMATCH_BLOCK_REASON,
  reconciliationFreshnessGateEnabled,
  resolveReconciliationMaxAgeMs,
  reconciliationGateBlockReason,
  REQUIRED_MARGIN_PROXY_PER_LOT_USD,
} = await import("../liveCommandPipeline.js");

const {
  Mt5EaBridgeAdapter,
  MT5_EA_BRIDGE_VENUE,
} = await import("../executionAdapter.js");
// Type-only: erased at runtime, so it does NOT defeat the dynamic-import
// pattern this suite uses to keep module init offline.
import type { Mt5DeliveryResult } from "../executionAdapter.js";

const { reconciliationFreshnessVerdict } = await import("../unknownReconciler.js");

const {
  RESERVED_RISK_IN_FLIGHT_STATUSES,
  RESERVED_RISK_ENTRY_COMMAND_TYPES,
  computeReservedRiskUsd,
} = await import("../masterBridgePool.js");

const {
  userHeadroomBlocksReservation,
  ARX_LOCK_NS_USER_ALLOCATION,
} = await import("../../concurrency/exposureReservation.js");

const { computeAvailableBalance } = await import("../investorLiveBalance.js");
const { ARX_LOCK_NS } = await import("../../concurrency/advisoryLock.js");

const pipelineSource = readFileSync(
  fileURLToPath(new URL("../liveCommandPipeline.ts", import.meta.url)),
  "utf8",
);
const exposureSource = readFileSync(
  fileURLToPath(new URL("../../concurrency/exposureReservation.ts", import.meta.url)),
  "utf8",
);

// ── 1. R2-S7 seam ───────────────────────────────────────────────────────────

test("adapter venue literal is CI-pinned", () => {
  assert.equal(MT5_EA_BRIDGE_VENUE, "mt5_ea_bridge");
  const adapter = new Mt5EaBridgeAdapter(async () => ({ mt5CommandId: 1, transportRef: "1", action: "X" }));
  assert.equal(adapter.venue, "mt5_ea_bridge");
});

test("deliver() is a pure pass-through: same command object in, same result out", async () => {
  const seen: unknown[] = [];
  const adapter = new Mt5EaBridgeAdapter(async (opts) => {
    seen.push(opts);
    return { mt5CommandId: 42, transportRef: "42", action: "OPEN_MARKET" };
  });
  const command = {
    liveRow: { commandId: "lvcmd_x" } as never,
    bridgeUserId: 7,
    bridgeConnectionId: 9,
  };
  const result = await adapter.deliver(command);
  assert.equal(seen.length, 1);
  assert.equal(seen[0], command, "the exact command object must be forwarded (no reshaping)");
  assert.deepEqual(result, { mt5CommandId: 42, transportRef: "42", action: "OPEN_MARKET" });
});

test("deliver() NEVER swallows a failure — rejection propagates verbatim", async () => {
  const adapter = new Mt5EaBridgeAdapter(async () => {
    throw new Error("UNMAPPED_LIVE_COMMAND_TYPE:BOGUS");
  });
  await assert.rejects(
    () => adapter.deliver({ liveRow: {} as never, bridgeUserId: 1, bridgeConnectionId: 1 }),
    /UNMAPPED_LIVE_COMMAND_TYPE:BOGUS/,
    "the pipeline's mark-failed handling depends on the rejection reaching it",
  );
});

test("pipeline consumes the interface: adapter import + injected wrap, no direct call (source pins)", () => {
  assert.ok(
    pipelineSource.includes('from "./executionAdapter.js"'),
    "pipeline must import the seam module",
  );
  assert.ok(
    /new Mt5EaBridgeAdapter\([\s\S]*?\(command\) => enqueueBridgedMt5Command\(\{/.test(pipelineSource),
    "the sole implementation must still wrap enqueueBridgedMt5Command with field-forwarding "
      + "(the wrapper now awaits it to attach the venue-neutral transportRef; the mirror-call "
      + "literal check-live-dispatch-cas matches must survive)",
  );
  // R6 — EVOLVED, NOT RELAXED. This used to pin the literal
  // `executionAdapter.deliver({`, which was only meaningful while exactly
  // one venue could ever exist. With a second venue that pin would have to be
  // deleted, so it is replaced by a strictly stronger invariant:
  //
  //   every reachable live execution venue routes through an explicitly
  //   REGISTERED certified adapter, and unknown venues fail closed.
  //
  // The old pin allowed exactly one adapter; this one allows exactly the
  // registered set and forbids anything reaching a venue outside it.
  assert.ok(
    /const executionAdapter = selectExecutionAdapter\(EXECUTION_ADAPTERS, [A-Za-z.]+\);/.test(pipelineSource),
    "the dispatch path must select its adapter from the registry, by the SERVER-persisted venue",
  );
  assert.ok(
    pipelineSource.includes("executionAdapter.deliver({"),
    "the dispatch path must deliver through the selected adapter",
  );
  assert.ok(
    !/\bmt5ExecutionAdapter\.deliver\(/.test(pipelineSource),
    "no venue-specific adapter may be invoked directly — that bypasses venue routing",
  );
  // The venue must come from the persisted row, never from a request body: a
  // client naming its own venue could select a more privileged execution path.
  assert.ok(
    /selectExecutionAdapter\(EXECUTION_ADAPTERS, row\.executionVenue\)/.test(pipelineSource),
    "the venue must be read from the server-persisted command row",
  );
  assert.ok(
    !/selectExecutionAdapter\([^)]*\b(req|args|body|payload)\./.test(pipelineSource),
    "the venue must never be taken from client-supplied input",
  );
  // The registry must be exhaustive over the venue union: a venue with no
  // registered adapter has to fail the BUILD, not fall back at runtime.
  assert.ok(
    /const EXECUTION_ADAPTERS: ExecutionAdapterRegistry = \{/.test(pipelineSource),
    "the registry must be typed as ExecutionAdapterRegistry (Record<ExecutionVenue, ...>) "
      + "so an unregistered venue is a compile error",
  );
  // And no default may creep back in.
  assert.ok(
    !/EXECUTION_ADAPTERS\[[^\]]+\]\s*(\?\?|\|\|)/.test(pipelineSource),
    "a fallback adapter would reintroduce the default venue the router refuses to have",
  );
  assert.ok(
    !pipelineSource.includes("await enqueueBridgedMt5Command("),
    "no direct enqueue call may bypass the seam",
  );
  assert.equal(
    pipelineSource.split("enqueueBridgedMt5Command({").length - 1, 1,
    "exactly ONE delivery invocation exists — inside the adapter injection (the CAS guard's mirror literal)",
  );
  assert.ok(
    /const mt5ExecutionAdapter: ExecutionAdapter(<[^>]+>)? =/.test(pipelineSource),
    "the instance must be typed as the INTERFACE (optionally parameterised by its "
      + "venue result) so R5's Deriv adapter can slot in — never as the concrete class",
  );
});

test("byte-equivalence: enqueueBridgedMt5Command body still owns the unchanged mailbox delivery (source pins)", () => {
  const fnStart = pipelineSource.indexOf("async function enqueueBridgedMt5Command");
  assert.ok(fnStart > -1, "the existing function must remain defined in the pipeline");
  const fnEnd = pipelineSource.indexOf("export type BridgedLiveOutcome", fnStart);
  const fnBody = pipelineSource.slice(fnStart, fnEnd);
  for (const pinned of [
    "UNMAPPED_LIVE_COMMAND_TYPE",
    "buildBridgedMt5CommandPayload({",
    "db.insert(mt5CommandsTable)",
    'status: "PENDING"',
    "resolveBrokerSymbolName",
  ]) {
    assert.ok(fnBody.includes(pinned), `delivery body must still contain ${pinned}`);
  }
});

test("source order: CAS claim → adapter deliver → mirror-failure mark-failed semantics intact", () => {
  const dispatchStart = pipelineSource.indexOf("export async function dispatchLiveCommand");
  const casAt = pipelineSource.indexOf("claimLiveCommandForDispatch(", dispatchStart);
  const deliverAt = pipelineSource.indexOf("executionAdapter.deliver({", dispatchStart);
  const bridgeFailedAt = pipelineSource.indexOf('"BRIDGE_ENQUEUE_FAILED"', dispatchStart);
  const unmappedMapAt = pipelineSource.indexOf('"BRIDGE_UNMAPPED_COMMAND_TYPE"', dispatchStart);
  assert.ok(dispatchStart > -1 && casAt > -1 && deliverAt > -1 && bridgeFailedAt > -1 && unmappedMapAt > -1);
  assert.ok(casAt < deliverAt, "double-send CAS must be claimed BEFORE any delivery");
  assert.ok(deliverAt < bridgeFailedAt, "the deliver call must sit inside the try whose catch fails the command CLOSED");
  const failClause = pipelineSource.slice(deliverAt, bridgeFailedAt + 2000);
  assert.ok(
    failClause.includes('status: "LIVE_FAILED"'),
    "a failed delivery must still mark the command LIVE_FAILED (mirror-failure semantics unchanged)",
  );
  assert.ok(
    failClause.includes("releaseReservation"),
    "a failed delivery must still release the exposure reservation",
  );
});

// ── 2. R3 slice 3 — reservation atomicity ───────────────────────────────────

test("user-allocation advisory-lock namespace is registered, distinct, and CI-pinned", () => {
  assert.equal(ARX_LOCK_NS_USER_ALLOCATION, 0x4152_5804);
  // The registry owns the namespace; the local export must BE the registry
  // value, and no OTHER registry entry may collide with it.
  assert.equal(ARX_LOCK_NS_USER_ALLOCATION, ARX_LOCK_NS.USER_ALLOCATION);
  for (const [name, value] of Object.entries(ARX_LOCK_NS)) {
    if (name === "USER_ALLOCATION") continue;
    assert.notEqual(
      ARX_LOCK_NS_USER_ALLOCATION, value,
      `must not collide with ARX_LOCK_NS.${name}`,
    );
  }
});

test("headroom read + reservation write run under the SAME user-keyed advisory lock (source-order pins)", () => {
  const fnStart = exposureSource.indexOf("export async function reserveExposureAtomicWithUserHeadroom");
  assert.ok(fnStart > -1);
  const fnEnd = exposureSource.indexOf("export async function releaseReservation", fnStart);
  const fnBody = exposureSource.slice(fnStart, fnEnd);
  const lockAt = fnBody.indexOf("withTxAdvisoryLock(");
  const nsAt = fnBody.indexOf("ARX_LOCK_NS_USER_ALLOCATION", lockAt);
  const allocReadAt = fnBody.indexOf("user_slot_allocation");
  const inFlightReadAt = fnBody.indexOf("arx_live_commands");
  const gapReadAt = fnBody.indexOf("arx_dispatch_exposure_reservations");
  const lossReadAt = fnBody.indexOf("arx_live_positions");
  const decisionAt = fnBody.indexOf("userHeadroomBlocksReservation(");
  const masterReserveAt = fnBody.indexOf("reserveExposureAtomic({");
  assert.ok(lockAt > -1 && nsAt > -1, "the user lock must be keyed in the USER_ALLOCATION namespace");
  for (const [label, at] of [
    ["allocated-funds read", allocReadAt],
    ["in-flight commands read", inFlightReadAt],
    ["reservation-gap read", gapReadAt],
    ["floating-loss read", lossReadAt],
    ["headroom decision", decisionAt],
    ["master reservation write", masterReserveAt],
  ] as const) {
    assert.ok(at > lockAt, `${label} must happen INSIDE the user advisory lock`);
  }
  assert.ok(decisionAt < masterReserveAt, "headroom must be decided BEFORE the reservation is written");
});

test("the master-exposure lock pattern is untouched (CI-guard parity pins)", () => {
  assert.ok(
    /withTxAdvisoryLock\(\s*ARX_LOCK_NS\.MASTER_EXPOSURE/.test(exposureSource),
    "reserveExposureAtomic must still run under ARX_LOCK_NS.MASTER_EXPOSURE",
  );
  assert.ok(
    /SUM\(lot_size\)[\s\S]{0,200}arx_dispatch_exposure_reservations[\s\S]{0,80}status = 'RESERVED'/.test(exposureSource),
    "the exposure aggregation must still include RESERVED rows",
  );
});

test("pipeline takes the headroom-locked reservation with the preflight governance split, entry-only (source pins)", () => {
  assert.ok(
    pipelineSource.includes("reserveExposureAtomicWithUserHeadroom({"),
    "dispatch must call the headroom-locked reservation",
  );
  assert.ok(
    /const enforceUserHeadroom = isEntryRow\s*\n?\s*&& \(!useGovernanceDispatch \|\| govDispatch\.enforceAllocationLimit\)/.test(pipelineSource),
    "headroom enforcement must mirror the preflight enforceMarginProxy governance split AND be entry-only",
  );
  // CI-guard parity: reservation still runs AFTER the user-access gate.
  const idxUser = pipelineSource.indexOf("loadAndEvaluateUserMasterLiveAccessGate(");
  const idxReserve = pipelineSource.indexOf("reserveExposureAtomic");
  assert.ok(idxUser > -1 && idxReserve > idxUser);
});

test("pure headroom predicate matrix (fail-closed, loss-clamped)", () => {
  const base = { allocatedFunds: 1000, reservedRiskUsd: 0, openFloatingLossUsd: 0, estRequiredMarginUsd: 1000 };
  assert.equal(userHeadroomBlocksReservation(base), false, "exactly-fitting margin passes");
  assert.equal(userHeadroomBlocksReservation({ ...base, estRequiredMarginUsd: 1000.01 }), true);
  assert.equal(
    userHeadroomBlocksReservation({ ...base, reservedRiskUsd: 600, estRequiredMarginUsd: 500 }),
    true, "in-flight reserved risk must shrink headroom",
  );
  assert.equal(
    userHeadroomBlocksReservation({ ...base, openFloatingLossUsd: -700, estRequiredMarginUsd: 400 }),
    true, "open floating losses must shrink headroom",
  );
  assert.equal(
    userHeadroomBlocksReservation({ allocatedFunds: 100, reservedRiskUsd: 0, openFloatingLossUsd: 500, estRequiredMarginUsd: 150 }),
    true, "a POSITIVE floating figure must be clamped to 0 — profit never inflates headroom",
  );
  // Fail-closed on corrupt inputs.
  for (const corrupt of [
    { ...base, allocatedFunds: Number.NaN },
    { ...base, reservedRiskUsd: Number.POSITIVE_INFINITY },
    { ...base, openFloatingLossUsd: Number.NaN },
    { ...base, estRequiredMarginUsd: Number.NaN },
    { ...base, estRequiredMarginUsd: -1 },
  ]) {
    assert.equal(userHeadroomBlocksReservation(corrupt), true, "corrupt input must refuse");
  }
});

test("headroom predicate arithmetic matches computeAvailableBalance (parity pin)", () => {
  const cases: Array<[number, number, number, number]> = [
    [1000, 0, 0, 500],
    [1000, 250, -100, 650],
    [1000, 250, -100, 651],
    [200, 300, 0, 1],
    [200, 300, 0, 0],
    [50, 0, -20, 30],
    [50, 0, -20, 31],
  ];
  for (const [alloc, reserved, loss, est] of cases) {
    const available = computeAvailableBalance(alloc, reserved, loss);
    assert.equal(
      userHeadroomBlocksReservation({
        allocatedFunds: alloc, reservedRiskUsd: reserved,
        openFloatingLossUsd: loss, estRequiredMarginUsd: est,
      }),
      est > available,
      `predicate must agree with computeAvailableBalance for (${alloc},${reserved},${loss},${est})`,
    );
  }
});

// ── 3. R3 slice 3 — reserved-risk computation matrix ────────────────────────

test("reserved-risk vocabulary + margin proxy are CI-pinned", () => {
  assert.deepEqual(
    [...RESERVED_RISK_IN_FLIGHT_STATUSES],
    ["SENT_TO_MT5_LIVE", "LIVE_UNKNOWN", "LIVE_RECONCILIATION_REQUIRED"],
  );
  assert.deepEqual(
    [...RESERVED_RISK_ENTRY_COMMAND_TYPES],
    ["PLACE_LIVE_MARKET_ORDER", "PLACE_LIVE_PENDING_ORDER"],
  );
  assert.equal(REQUIRED_MARGIN_PROXY_PER_LOT_USD, 1000);
});

test("computeReservedRiskUsd matrix: statuses, entry-only, sums, corrupt rows", () => {
  const P = REQUIRED_MARGIN_PROXY_PER_LOT_USD;
  const entry = "PLACE_LIVE_MARKET_ORDER";
  // Every in-flight status counts — including both epistemic states, which
  // HOLD their reservation by the G1b matrix.
  for (const status of RESERVED_RISK_IN_FLIGHT_STATUSES) {
    assert.equal(
      computeReservedRiskUsd([{ status, commandType: entry, requestedVolume: 0.5 }], P),
      0.5 * P,
      `${status} must count as reserved risk`,
    );
  }
  // Non-in-flight statuses never count.
  for (const status of ["LIVE_DRAFT", "LIVE_APPROVED", "LIVE_FILLED", "LIVE_REJECTED", "LIVE_BLOCKED", "LIVE_EXPIRED", "LIVE_CLOSED"]) {
    assert.equal(computeReservedRiskUsd([{ status, commandType: entry, requestedVolume: 2 }], P), 0);
  }
  // Entry-only: an in-flight close/modify is risk-reducing intent.
  for (const commandType of ["CLOSE_LIVE_POSITION", "MODIFY_LIVE_SLTP"]) {
    assert.equal(
      computeReservedRiskUsd([{ status: "SENT_TO_MT5_LIVE", commandType, requestedVolume: 2 }], P),
      0,
    );
  }
  // Sums across mixed rows.
  assert.equal(
    computeReservedRiskUsd([
      { status: "SENT_TO_MT5_LIVE", commandType: "PLACE_LIVE_MARKET_ORDER", requestedVolume: 0.5 },
      { status: "LIVE_UNKNOWN", commandType: "PLACE_LIVE_PENDING_ORDER", requestedVolume: 1.5 },
      { status: "SENT_TO_MT5_LIVE", commandType: "CLOSE_LIVE_POSITION", requestedVolume: 9 },
      { status: "LIVE_FILLED", commandType: "PLACE_LIVE_MARKET_ORDER", requestedVolume: 9 },
    ], P),
    2 * P,
  );
  // Corrupt volumes contribute 0 — never fabricated, never negative capacity.
  assert.equal(
    computeReservedRiskUsd([
      { status: "SENT_TO_MT5_LIVE", commandType: entry, requestedVolume: null },
      { status: "SENT_TO_MT5_LIVE", commandType: entry, requestedVolume: "abc" },
      { status: "SENT_TO_MT5_LIVE", commandType: entry, requestedVolume: -1 },
      { status: "SENT_TO_MT5_LIVE", commandType: entry, requestedVolume: 0 },
      { status: "SENT_TO_MT5_LIVE", commandType: entry, requestedVolume: "0.25" },
    ], P),
    0.25 * P,
  );
  // Corrupt proxy is a bug tripwire — returns 0, never NaN.
  for (const proxy of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
    assert.equal(
      computeReservedRiskUsd([{ status: "SENT_TO_MT5_LIVE", commandType: entry, requestedVolume: 1 }], proxy),
      0,
    );
  }
});

// ── 4. R2-S4 — reconciliation-freshness gate (flag-staged) ──────────────────

test("freshness-gate literals are CI-pinned", () => {
  assert.equal(RECONCILIATION_FRESHNESS_GATE_ENV, "ARX_REQUIRE_FRESH_RECONCILIATION");
  assert.equal(RECONCILIATION_MAX_AGE_ENV, "ARX_RECONCILIATION_MAX_AGE_MS");
  assert.equal(DEFAULT_RECONCILIATION_MAX_AGE_MS, 300_000);
  assert.equal(RECONCILIATION_STALE_BLOCK_REASON, "LIVE_BLOCKED:RECONCILIATION_STALE");
  assert.equal(RECONCILIATION_MISMATCH_BLOCK_REASON, "LIVE_BLOCKED:RECONCILIATION_MISMATCH");
});

test("flag parse: DEFAULT OFF — only an explicit enable value turns the gate on", () => {
  for (const off of [undefined, null, "", "  ", "false", "FALSE", "0", "off", "no", "banana"]) {
    assert.equal(reconciliationFreshnessGateEnabled(off), false, `${String(off)} must stay OFF`);
  }
  for (const on of ["1", "true", "TRUE", " on ", "yes", "On"]) {
    assert.equal(reconciliationFreshnessGateEnabled(on), true, `${on} must enable`);
  }
});

test("max-age parse: positive finite ms, else the documented default (never 'no bound')", () => {
  assert.equal(resolveReconciliationMaxAgeMs(undefined), DEFAULT_RECONCILIATION_MAX_AGE_MS);
  assert.equal(resolveReconciliationMaxAgeMs(""), DEFAULT_RECONCILIATION_MAX_AGE_MS);
  assert.equal(resolveReconciliationMaxAgeMs("60000"), 60_000);
  assert.equal(resolveReconciliationMaxAgeMs(" 1500.9 "), 1500);
  for (const bad of ["0", "-5", "abc", "NaN", "Infinity"]) {
    assert.equal(resolveReconciliationMaxAgeMs(bad), DEFAULT_RECONCILIATION_MAX_AGE_MS, `${bad} must fall back`);
  }
});

test("gate matrix (flag ON): fresh-pass / stale / mismatch / no-run fail-closed", () => {
  const NOW = new Date("2026-08-20T12:00:00Z");
  const maxAge = DEFAULT_RECONCILIATION_MAX_AGE_MS;
  const verdictOf = (row: Parameters<typeof reconciliationFreshnessVerdict>[0]) =>
    reconciliationGateBlockReason(reconciliationFreshnessVerdict(row, maxAge, NOW));

  // Fresh + clean → pass (no block).
  assert.equal(verdictOf({
    status: "COMPLETED", completedAt: new Date(NOW.getTime() - 60_000),
    positionsMatch: true, ordersMatch: true,
  }), null);
  // Stale run → STALE.
  assert.equal(verdictOf({
    status: "COMPLETED", completedAt: new Date(NOW.getTime() - maxAge - 1),
    positionsMatch: true, ordersMatch: true,
  }), RECONCILIATION_STALE_BLOCK_REASON);
  // Verified mismatch → MISMATCH (its own literal), fresh or not.
  assert.equal(verdictOf({
    status: "COMPLETED", completedAt: new Date(NOW.getTime() - 60_000),
    positionsMatch: false, ordersMatch: true,
  }), RECONCILIATION_MISMATCH_BLOCK_REASON);
  assert.equal(verdictOf({
    status: "COMPLETED", completedAt: new Date(NOW.getTime() - 60_000),
    positionsMatch: true, ordersMatch: false,
  }), RECONCILIATION_MISMATCH_BLOCK_REASON);
  // No run at all → fail-closed STALE (the zero-runs bootstrap state).
  assert.equal(verdictOf(null), RECONCILIATION_STALE_BLOCK_REASON);
  // Unfinished / crashed run → STALE.
  assert.equal(verdictOf({
    status: "RUNNING", completedAt: null, positionsMatch: null, ordersMatch: null,
  }), RECONCILIATION_STALE_BLOCK_REASON);
  // Completed but match UNVERIFIED (NULL) → STALE, never a silent pass.
  assert.equal(verdictOf({
    status: "COMPLETED", completedAt: new Date(NOW.getTime() - 60_000),
    positionsMatch: null, ordersMatch: true,
  }), RECONCILIATION_STALE_BLOCK_REASON);
  // Future-dated completion → STALE (unexplainable clock state).
  assert.equal(verdictOf({
    status: "COMPLETED", completedAt: new Date(NOW.getTime() + 60_000),
    positionsMatch: true, ordersMatch: true,
  }), RECONCILIATION_STALE_BLOCK_REASON);
});

test("dispatch wires the gate entry-only, flag-guarded, after the feed gate and before the evaluator (source pins)", () => {
  const dispatchStart = pipelineSource.indexOf("export async function dispatchLiveCommand");
  const feedAt = pipelineSource.indexOf("evaluateLiveEntryFeedGate({", dispatchStart);
  const gateAt = pipelineSource.indexOf("reconciliationFreshnessGateEnabled(process.env[RECONCILIATION_FRESHNESS_GATE_ENV])", dispatchStart);
  const verdictAt = pipelineSource.indexOf("reconciliationFreshnessVerdict(", dispatchStart);
  const evaluatorAt = pipelineSource.indexOf("evaluateLivePhaseBDispatchGate({", dispatchStart);
  assert.ok(dispatchStart > -1 && feedAt > -1 && gateAt > -1 && verdictAt > -1 && evaluatorAt > -1);
  assert.ok(feedAt < gateAt, "freshness gate runs after the broker-feed pre-gate");
  assert.ok(gateAt < verdictAt && verdictAt < evaluatorAt, "freshness gate must decide BEFORE the 18-gate evaluator");
  assert.ok(
    /if \(isWave4EntryCommand\s*\n?\s*&& reconciliationFreshnessGateEnabled\(/.test(pipelineSource),
    "the gate must be ENTRY-ONLY and flag-guarded in the same predicate",
  );
  const gateBody = pipelineSource.slice(gateAt, evaluatorAt);
  assert.ok(gateBody.includes("reconciliation_runs"), "the gate reads the newest reconciliation_runs row");
  assert.ok(gateBody.includes("runReadError"), "an unreadable table must degrade to no-run (fail-closed), not throw");
});

test("startup notice: the staged default is named loudly at module init (source pin)", () => {
  assert.ok(
    pipelineSource.includes("RECONCILIATION_FRESHNESS_GATE_OFF"),
    "module init must log when the gate is off (default this release)",
  );
  assert.ok(
    pipelineSource.includes("docs/OWNER_DECISIONS.md"),
    "the default-flip must cite the Owner Decision Registry",
  );
});

// ── R5 groundwork — the seam's RETURN type is venue-neutral ─────────────────

test("DeliveryResult exposes a venue-neutral transportRef, and MT5 carries both", async () => {
  const adapter = new Mt5EaBridgeAdapter(
    async () => ({ mt5CommandId: 77, transportRef: "77", action: "OPEN_MARKET" }),
  );
  const r = await adapter.deliver({
    liveRow: {} as never, bridgeUserId: 1, bridgeConnectionId: 2,
  });
  // transportRef is what a second venue implements; mt5CommandId stays typed
  // for the existing audit/logging consumers.
  assert.equal(r.transportRef, "77");
  assert.equal(r.mt5CommandId, 77);
});

test("the seam's INPUT is deliberately NOT generalized yet", () => {
  const src = readFileSync(
    new URL("../executionAdapter.ts", import.meta.url), "utf8",
  );
  // ExecutionDeliveryCommand still carries an MT5-lot-shaped ArxLiveCommand.
  // Generalizing it before a certified Deriv round-trip would be guessing at
  // the most safety-critical boundary; the file must SAY so rather than leave
  // a future reader assuming the seam is finished.
  assert.match(src, /NOT generalized yet, deliberately/);
  assert.match(src, /ExecutionDeliveryCommand still carries/);
});

// ── Behavioural proof that .then() did not change delivery semantics ─────────
//
// The source pins above are LEXICAL (exactly one enqueue call site, inside the
// adapter injection) and therefore fragile on their own. These tests pin the
// OBSERVABLE contract instead, so a future rewrite — await, .then(), or
// anything else — is judged on behaviour rather than spelling.
//
// Note what the contract actually is: the caller MUST wait for delivery to
// settle. It destructures mt5CommandId to proceed, so fire-and-forget delivery
// would drop both the mailbox id and any mirror failure. That was true of the
// original wrapper too (it returned the promise directly and the call site
// awaited it) — the risk to guard against is a rewrite that makes delivery
// NOT awaited, not one that keeps waiting.

test("deliver() does NOT settle before the underlying enqueue settles", async () => {
  let releaseEnqueue!: (v: Mt5DeliveryResult) => void;
  const enqueueGate = new Promise<Mt5DeliveryResult>((resolve) => { releaseEnqueue = resolve; });

  const adapter = new Mt5EaBridgeAdapter(
    (command) => enqueueGate.then((r) => ({ ...r, transportRef: String(r.mt5CommandId) })),
  );

  let settled = false;
  const delivery = adapter
    .deliver({ liveRow: {} as never, bridgeUserId: 1, bridgeConnectionId: 2 })
    .then((r) => { settled = true; return r; });

  // Flush the microtask queue several times: if delivery were fire-and-forget
  // (or resolved independently of enqueue) it would have settled by now.
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(settled, false, "delivery must not settle while enqueue is still pending");

  releaseEnqueue({ mt5CommandId: 99, transportRef: "99", action: "OPEN_MARKET" });
  const result = await delivery;
  assert.equal(settled, true, "delivery settles once enqueue settles");
  assert.equal(result.mt5CommandId, 99, "the mailbox id reaches the caller");
  assert.equal(result.transportRef, "99", "the venue-neutral handle reaches the caller");
});

test("a delivery failure REJECTS the caller rather than resolving silently", async () => {
  const adapter = new Mt5EaBridgeAdapter(
    () => Promise.reject(new Error("BRIDGE_ENQUEUE_FAILED")),
  );
  // The pipeline's mark-failed path depends on this rejection arriving; a
  // wrapper that swallowed it would strand the command as SENT forever.
  await assert.rejects(
    () => adapter.deliver({ liveRow: {} as never, bridgeUserId: 1, bridgeConnectionId: 2 }),
    /BRIDGE_ENQUEUE_FAILED/,
  );
});

test("the pipeline AWAITS delivery — delivery is not fire-and-forget at the call site", () => {
  // The behavioural counterpart to the lexical pins: whatever the wrapper's
  // spelling, the dispatch path must consume delivery's settled result.
  assert.match(
    pipelineSource,
    /await executionAdapter\.deliver\(\{/,
    "the dispatch path must await the SELECTED adapter's delivery and use its settled result",
  );
});
