// ── ARX Bridge v2 kernel test (Task #371, Phase 18) ─────────────────────────
//
// Deterministic, no-IO test of the PURE Bridge v2 domain contract:
//   - message validation (envelope + per-type payload, honest reject codes),
//   - per-stream sequence classification (first / in-order / gap / dup / reset),
//   - freshness classification,
//   - lifecycle mapping (NEVER a fabricated fill without broker evidence).
//
// These are the truth-shapes the EA→server ingest relies on. If any assertion
// fails the kernel's safety contract has drifted.

import { bridgeV2 } from "@workspace/domain";

const {
  validateBridgeV2Message,
  classifySequence,
  classifyFreshness,
  mapLifecycleForMessage,
  lifecycleFromCommandResult,
  isFilledState,
  BRIDGE_V2_PROTOCOL_VERSION,
} = bridgeV2;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(label);
  }
}

function eq<T>(actual: T, expected: T, label: string): void {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// Helper: a valid envelope for a given type/payload.
function msg(messageType: string, payload: unknown, over: Record<string, unknown> = {}): unknown {
  return {
    protocolVersion: BRIDGE_V2_PROTOCOL_VERSION,
    messageType,
    streamKey: "default",
    sequence: 1,
    idempotencyKey: "idem-0000000001",
    eaCreatedAtEpochMs: Date.now(),
    eaVersion: "2.00",
    payload,
    ...over,
  };
}

// ── 1. Validation: happy path for each representative type ───────────────────
{
  const hb = validateBridgeV2Message(
    msg("HEARTBEAT", { accountType: "live", terminalConnected: true, algoTradingAllowed: true }),
  );
  ok(hb.ok, "HEARTBEAT valid");

  const acct = validateBridgeV2Message(
    msg("ACCOUNT_SNAPSHOT", { balance: 1000, equity: 1010, margin: 0, freeMargin: 1010, currency: "USD" }),
  );
  ok(acct.ok, "ACCOUNT_SNAPSHOT valid");

  const emptyBook = validateBridgeV2Message(
    msg("POSITIONS_SNAPSHOT", { positions: [], sweepComplete: true }),
  );
  ok(emptyBook.ok, "POSITIONS_SNAPSHOT empty book is valid (book-is-empty is a fact)");
}

// ── 2. Validation: honest rejection codes (never fabricate success) ──────────
{
  const badEnv = validateBridgeV2Message({ messageType: "HEARTBEAT" });
  eq(badEnv.ok, false, "missing envelope fields rejected");
  if (!badEnv.ok) eq(badEnv.error, "ENVELOPE_INVALID", "missing envelope → ENVELOPE_INVALID");

  const wrongProto = validateBridgeV2Message(
    msg("HEARTBEAT", { accountType: "live", terminalConnected: true, algoTradingAllowed: true }, { protocolVersion: 1 }),
  );
  eq(wrongProto.ok, false, "wrong protocol version rejected");

  const unknownType = validateBridgeV2Message(
    msg("NOT_A_TYPE", {}),
  );
  eq(unknownType.ok, false, "unknown message type rejected");

  const badPayload = validateBridgeV2Message(
    msg("ACCOUNT_SNAPSHOT", { balance: "oops" }),
  );
  eq(badPayload.ok, false, "bad payload rejected");
  if (!badPayload.ok) eq(badPayload.error, "PAYLOAD_INVALID", "bad payload → PAYLOAD_INVALID");

  // An in-progress candle must never validate as a closed bar.
  const openBar = validateBridgeV2Message(
    msg("CANDLE", { symbol: "EURUSD", timeframe: "M5", openTimeEpochMs: Date.now(), open: 1, high: 1, low: 1, close: 1, volume: 0, isClosed: false }),
  );
  eq(openBar.ok, false, "non-closed candle rejected (only closed bars are truth)");
}

// ── 3. Sequence classification ──────────────────────────────────────────────
{
  eq(classifySequence(null, 5).verdict, "FIRST", "null lastSeen → FIRST");
  ok(classifySequence(null, 5).accept, "FIRST accepted");

  eq(classifySequence(5, 6).verdict, "IN_ORDER", "lastSeen+1 → IN_ORDER");

  const gap = classifySequence(5, 9);
  eq(gap.verdict, "GAP", "ahead → GAP");
  eq(gap.gapSize, 3, "gap size = incoming - lastSeen - 1");
  ok(gap.accept, "GAP still accepted (process, but record the loss)");

  const dup = classifySequence(5, 5);
  eq(dup.verdict, "DUPLICATE", "repeat → DUPLICATE");
  ok(!dup.accept, "DUPLICATE not accepted (idempotent drop)");
  eq(dup.nextLastSeen, 5, "DUPLICATE never rewinds lastSeen");

  const older = classifySequence(5, 3);
  eq(older.verdict, "DUPLICATE", "older seq → DUPLICATE");
  ok(!older.accept, "older seq dropped");

  const reset = classifySequence(42, 0);
  eq(reset.verdict, "RESET", "drop to 0 after high → RESET");
  ok(reset.accept, "RESET accepted and re-anchored");
  eq(reset.nextLastSeen, 0, "RESET re-anchors to 0");

  const malformed = classifySequence(5, -1);
  ok(!malformed.accept, "negative incoming never accepted");
}

// ── 4. Freshness ────────────────────────────────────────────────────────────
{
  eq(classifyFreshness(0), "LIVE", "0ms → LIVE");
  eq(classifyFreshness(5_000), "LIVE", "5s boundary → LIVE");
  eq(classifyFreshness(5_001), "DELAYED", "just over 5s → DELAYED");
  eq(classifyFreshness(30_000), "DELAYED", "30s boundary → DELAYED");
  eq(classifyFreshness(30_001), "STALE", "over 30s → STALE");
}

// ── 5. Lifecycle mapping — NEVER fabricate a fill ───────────────────────────
{
  // COMMAND_RESULT EXECUTED with a broker ticket = FILLED; without = FAILED.
  eq(
    mapLifecycleForMessage("COMMAND_RESULT", { outcome: "EXECUTED", brokerTicket: "12345" }),
    "FILLED",
    "EXECUTED + ticket → FILLED",
  );
  eq(
    mapLifecycleForMessage("COMMAND_RESULT", { outcome: "EXECUTED" }),
    "FAILED",
    "EXECUTED without broker ticket → FAILED (no fabricated fill)",
  );
  eq(
    mapLifecycleForMessage("COMMAND_RESULT", { outcome: "REJECTED" }),
    "REJECTED",
    "REJECTED → REJECTED",
  );

  // TRADE_TRANSACTION: DEAL_ADD with deal ticket = FILLED; without deal = not.
  eq(
    mapLifecycleForMessage("TRADE_TRANSACTION", { transactionType: "TRADE_TRANSACTION_DEAL_ADD", dealTicket: "999" }),
    "FILLED",
    "DEAL_ADD + dealTicket → FILLED",
  );
  eq(
    mapLifecycleForMessage("TRADE_TRANSACTION", { transactionType: "TRADE_TRANSACTION_DEAL_ADD" }),
    null,
    "DEAL_ADD without dealTicket → no lifecycle (not a confirmed fill)",
  );
  eq(
    mapLifecycleForMessage("TRADE_TRANSACTION", { transactionType: "TRADE_TRANSACTION_REQUEST" }),
    "BROKER_RECEIVED",
    "REQUEST → BROKER_RECEIVED",
  );

  // Telemetry types carry NO lifecycle — the mapper is EXHAUSTIVE over all 12
  // v2 message types, so each non-lifecycle type explicitly returns null
  // (honesty over coverage count; a snapshot is never inferred into a fill).
  eq(mapLifecycleForMessage("TICK", { symbol: "EURUSD" }), null, "TICK → no lifecycle");
  eq(mapLifecycleForMessage("HEARTBEAT", {}), null, "HEARTBEAT → no lifecycle");
  eq(mapLifecycleForMessage("ACCOUNT_SNAPSHOT", {}), null, "ACCOUNT_SNAPSHOT → no lifecycle");
  eq(mapLifecycleForMessage("POSITIONS_SNAPSHOT", { positions: [] }), null, "POSITIONS_SNAPSHOT → no lifecycle (snapshot never inferred as fill)");
  eq(mapLifecycleForMessage("ORDERS_SNAPSHOT", { orders: [] }), null, "ORDERS_SNAPSHOT → no lifecycle");
  eq(mapLifecycleForMessage("CANDLE", { symbol: "EURUSD" }), null, "CANDLE → no lifecycle");
  eq(mapLifecycleForMessage("SYMBOL_SPEC", { symbol: "EURUSD" }), null, "SYMBOL_SPEC → no lifecycle");
  eq(mapLifecycleForMessage("ERROR_REPORT", { code: "X", message: "y" }), null, "ERROR_REPORT → no lifecycle");
  eq(mapLifecycleForMessage("CONFIG_ACK", { appliedConfigVersion: 3 }), null, "CONFIG_ACK → no lifecycle");
  // DEAL_HISTORY is a lifecycle-bearing type (realised closed-leg truth), NOT
  // telemetry — it maps to CLOSED, a terminal state.
  eq(mapLifecycleForMessage("DEAL_HISTORY", { deals: [] }), "CLOSED", "DEAL_HISTORY → CLOSED (realised closed-leg truth)");

  // lifecycleFromCommandResult never returns a filled state without a ticket.
  eq(lifecycleFromCommandResult("EXECUTED", false), "FAILED", "EXECUTED no ticket → FAILED");
  eq(lifecycleFromCommandResult("PARTIAL", false), "FAILED", "PARTIAL no ticket → FAILED");
  ok(isFilledState("FILLED"), "FILLED is a filled state");
  ok(!isFilledState("FAILED"), "FAILED is not a filled state");
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\nBridge v2 kernel test: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("All Bridge v2 kernel assertions passed.");
