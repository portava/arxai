// Unit tests for the Self-Trade AI PROTECTIVE-ACTION pure domain module
// (lib/domain/src/self-trade/protectiveAction.ts): trigger classification,
// the three exposure/reverse/stop invariants with the full edge table for BUY
// and SELL, adversarial intents, bridge + position identity, hold-reason text.
// No IO; deterministic. Run: pnpm --filter @workspace/scripts run
// test:self-trade-protective-domain

import {
  classifyProtectiveTrigger,
  doesNotIncreaseExposure,
  doesNotReverse,
  doesNotLoosenStop,
  evaluateProtectiveGeometry,
  verifyProtectiveBridge,
  verifyProtectivePosition,
  explainProtectiveHold,
  redactProtectiveDetail,
  PROTECTIVE_HOLD_REASONS,
  evaluateManagementAction,
  type ProtectivePositionFacts,
  type ProtectiveIntent,
  type ProtectiveCheck,
  type ProtectiveEntryFacts,
  type ProtectiveExecutionFacts,
  type ProtectiveBridgeFacts,
  type ProtectiveRowFacts,
  type PositionManagementVerdict,
} from "@workspace/domain/self-trade";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const reason = (v: ProtectiveCheck): string => (v.ok ? "OK" : v.reason);
function expect(name: string, v: ProtectiveCheck, want: string): void {
  check(name, reason(v) === want, `got ${reason(v)}${v.ok ? "" : ` ${JSON.stringify(v.detail)}`}`);
}

// ── 1. classifyProtectiveTrigger — every verdict shape ───────────────────────
{
  const verdict = (action: PositionManagementVerdict["action"], trigger: PositionManagementVerdict["trigger"]): PositionManagementVerdict =>
    ({ action, trigger, reason: "", rMultiple: 0, newStopLoss: action === "EXIT" || action === "HOLD" || action === "TAKE_PARTIAL" ? null : 1.1, partialFraction: null });
  check("INVALIDATION_BREACH EXIT ⇒ EXIT_INVALIDATION", classifyProtectiveTrigger(verdict("EXIT", "INVALIDATION_BREACH")) === "EXIT_INVALIDATION");
  check("FINAL_TARGET EXIT ⇒ not protective (profit-taking)", classifyProtectiveTrigger(verdict("EXIT", "FINAL_TARGET")) === null);
  check("FIRST_TARGET partial ⇒ not protective", classifyProtectiveTrigger(verdict("TAKE_PARTIAL", "FIRST_TARGET")) === null);
  check("BREAK_EVEN ⇒ MOVE_TO_BE", classifyProtectiveTrigger(verdict("MOVE_TO_BE", "BREAK_EVEN")) === "MOVE_TO_BE");
  check("TRAIL ⇒ TIGHTEN_SL", classifyProtectiveTrigger(verdict("TIGHTEN_SL", "TRAIL")) === "TIGHTEN_SL");
  check("HOLD ⇒ null", classifyProtectiveTrigger(verdict("HOLD", null)) === null);
  check("EXIT without a trigger ⇒ null (never guessed)", classifyProtectiveTrigger(verdict("EXIT", null)) === null);
  check("mismatched action/trigger pair ⇒ null", classifyProtectiveTrigger(verdict("MOVE_TO_BE", "TRAIL")) === null);

  // The real evaluator stamps the trigger it fired on.
  const base = {
    side: "BUY" as const, entryPrice: 1.1, stopLoss: 1.095, currentSl: 1.095,
    takeProfits: [{ from: 1.105, to: 1.105 }, { from: 1.11, to: 1.11 }],
    invalidation: 1.094, beMoved: false, partialsTaken: 0, autonomyLevel: 3,
  };
  check("evaluator: invalidation breach carries INVALIDATION_BREACH", evaluateManagementAction({ ...base, currentPrice: 1.0935 }).trigger === "INVALIDATION_BREACH");
  check("evaluator: final target carries FINAL_TARGET", evaluateManagementAction({ ...base, currentPrice: 1.1105 }).trigger === "FINAL_TARGET");
  check("evaluator: first target carries FIRST_TARGET", evaluateManagementAction({ ...base, currentPrice: 1.1052 }).trigger === "FIRST_TARGET");
  check("evaluator: break-even carries BREAK_EVEN", evaluateManagementAction({ ...base, currentPrice: 1.1051, partialsTaken: 1 }).trigger === "BREAK_EVEN");
  check("evaluator: trail carries TRAIL", evaluateManagementAction({ ...base, currentPrice: 1.108, partialsTaken: 1, beMoved: true }).trigger === "TRAIL");
  check("evaluator: hold carries null", evaluateManagementAction({ ...base, currentPrice: 1.101 }).trigger === null);
  check("evaluator: SELL invalidation breach carries INVALIDATION_BREACH",
    evaluateManagementAction({ ...base, side: "SELL", stopLoss: 1.105, currentSl: 1.105, invalidation: 1.106, takeProfits: [], currentPrice: 1.1065 }).trigger === "INVALIDATION_BREACH");
}

// ── 2. Edge table — BUY (entry 1.1000) ───────────────────────────────────────
const BUY: ProtectivePositionFacts = { side: "BUY", volume: 0.1, entryPrice: 1.1, currentPrice: 1.112, stopLoss: 1.095, takeProfit: null };
const modify = (pos: ProtectivePositionFacts, newStopLoss: unknown, newTakeProfit: unknown = pos.takeProfit): ProtectiveIntent =>
  ({ kind: "MODIFY_STOP", side: pos.side, newStopLoss, newTakeProfit } as unknown as ProtectiveIntent);
// Explicit arity: an explicit `undefined` must reach the predicate (a default
// parameter would silently replace it with the position's own volume).
const close = (pos: ProtectivePositionFacts, ...rest: unknown[]): ProtectiveIntent =>
  ({
    kind: "CLOSE",
    side: rest.length > 1 ? rest[1] : pos.side,
    volume: rest.length > 0 ? rest[0] : pos.volume,
  }) as unknown as ProtectiveIntent;
{
  const rows: Array<[number | null, number, unknown, string]> = [
    [1.095, 1.112, 1.1, "OK"],
    [1.095, 1.112, 1.095, "PROTECTIVE_STOP_NOT_TIGHTER"],
    [1.095, 1.112, 1.095 + 1e-12, "PROTECTIVE_STOP_NOT_TIGHTER"],
    [1.095, 1.112, 1.095 + 1e-8, "OK"],
    [1.095, 1.112, 1.094, "PROTECTIVE_STOP_NOT_TIGHTER"],
    [1.095, 1.112, 1.112, "PROTECTIVE_STOP_THROUGH_PRICE"],
    [1.095, 1.112, 1.112 - 1e-12, "PROTECTIVE_STOP_THROUGH_PRICE"],
    [1.095, 1.112, 1.113, "PROTECTIVE_STOP_THROUGH_PRICE"],
    [null, 1.112, 1.1, "OK"],
    [null, 1.112, 1.12, "PROTECTIVE_STOP_THROUGH_PRICE"],
    [1.095, 1.112, null, "PROTECTIVE_STOP_NOT_TIGHTER"],
    [1.095, 1.112, Number.NaN, "PROTECTIVE_GEOMETRY_INVALID"],
    [1.095, 1.112, 0, "PROTECTIVE_GEOMETRY_INVALID"],
    [1.095, 1.112, -1, "PROTECTIVE_GEOMETRY_INVALID"],
    [1.095, 1.112, "1.1", "PROTECTIVE_GEOMETRY_INVALID"],
    [1.095, 1.112, Number.POSITIVE_INFINITY, "PROTECTIVE_GEOMETRY_INVALID"],
    [1.095, 1.112, undefined, "PROTECTIVE_GEOMETRY_INVALID"],
  ];
  for (const [c, p, s, want] of rows) {
    const pos = { ...BUY, stopLoss: c, currentPrice: p };
    expect(`BUY c=${c} p=${p} s=${String(s)} full geometry`, evaluateProtectiveGeometry(pos, modify(pos, s)), want);
    expect(`BUY c=${c} p=${p} s=${String(s)} doesNotLoosenStop`, doesNotLoosenStop(pos, modify(pos, s)), want);
  }
  // Exact-equality stop at price (no EPS slack in either direction).
  expect("BUY stop exactly at price − EPS/2 refuses", doesNotLoosenStop(BUY, modify(BUY, 1.112 - 5e-10)), "PROTECTIVE_STOP_THROUGH_PRICE");
  expect("BUY stop at price − 2·EPS passes", doesNotLoosenStop(BUY, modify(BUY, 1.112 - 2e-9)), "OK");
  expect("BUY CLOSE never consults the stop", doesNotLoosenStop({ ...BUY, stopLoss: null }, close(BUY)), "OK");
}

// ── 3. Edge table — SELL (entry 1.1000) ──────────────────────────────────────
const SELL: ProtectivePositionFacts = { side: "SELL", volume: 0.1, entryPrice: 1.1, currentPrice: 1.088, stopLoss: 1.105, takeProfit: null };
{
  const rows: Array<[number | null, number, unknown, string]> = [
    [1.105, 1.088, 1.1, "OK"],
    [1.105, 1.088, 1.105, "PROTECTIVE_STOP_NOT_TIGHTER"],
    [1.105, 1.088, 1.105 - 1e-12, "PROTECTIVE_STOP_NOT_TIGHTER"],
    [1.105, 1.088, 1.105 - 1e-8, "OK"],
    [1.105, 1.088, 1.106, "PROTECTIVE_STOP_NOT_TIGHTER"],
    [1.105, 1.088, 1.088, "PROTECTIVE_STOP_THROUGH_PRICE"],
    [1.105, 1.088, 1.088 + 1e-12, "PROTECTIVE_STOP_THROUGH_PRICE"],
    [1.105, 1.088, 1.087, "PROTECTIVE_STOP_THROUGH_PRICE"],
    [null, 1.088, 1.1, "OK"],
    [null, 1.088, 1.08, "PROTECTIVE_STOP_THROUGH_PRICE"],
    [1.105, 1.088, null, "PROTECTIVE_STOP_NOT_TIGHTER"],
    [1.105, 1.088, Number.NaN, "PROTECTIVE_GEOMETRY_INVALID"],
    [1.105, 1.088, 0, "PROTECTIVE_GEOMETRY_INVALID"],
    [1.105, 1.088, -1, "PROTECTIVE_GEOMETRY_INVALID"],
    [1.105, 1.088, "1.1", "PROTECTIVE_GEOMETRY_INVALID"],
  ];
  for (const [c, p, s, want] of rows) {
    const pos = { ...SELL, stopLoss: c, currentPrice: p };
    expect(`SELL c=${c} p=${p} s=${String(s)} full geometry`, evaluateProtectiveGeometry(pos, modify(pos, s)), want);
    expect(`SELL c=${c} p=${p} s=${String(s)} doesNotLoosenStop`, doesNotLoosenStop(pos, modify(pos, s)), want);
  }
}

// ── 4. Take-profit pinning ───────────────────────────────────────────────────
{
  const withTp = { ...BUY, takeProfit: 1.13 };
  expect("TP 1.1300 → intent TP 1.1250 (toward) refuses", evaluateProtectiveGeometry(withTp, modify(withTp, 1.1, 1.125)), "PROTECTIVE_TAKE_PROFIT_CHANGED");
  expect("TP 1.1300 → intent TP 1.1400 (away) refuses", evaluateProtectiveGeometry(withTp, modify(withTp, 1.1, 1.14)), "PROTECTIVE_TAKE_PROFIT_CHANGED");
  expect("TP 1.1300 → intent TP null (removal) refuses", evaluateProtectiveGeometry(withTp, modify(withTp, 1.1, null)), "PROTECTIVE_TAKE_PROFIT_CHANGED");
  expect("TP 1.1300 → same TP passes", evaluateProtectiveGeometry(withTp, modify(withTp, 1.1, 1.13)), "OK");
  expect("TP null → intent TP null passes", evaluateProtectiveGeometry(BUY, modify(BUY, 1.1, null)), "OK");
  expect("TP null → intent TP number (adding one) refuses", evaluateProtectiveGeometry(BUY, modify(BUY, 1.1, 1.13)), "PROTECTIVE_TAKE_PROFIT_CHANGED");
  expect("TP NaN on intent is shape-invalid", evaluateProtectiveGeometry(withTp, modify(withTp, 1.1, Number.NaN)), "PROTECTIVE_GEOMETRY_INVALID");
  expect("TP string on intent is shape-invalid", evaluateProtectiveGeometry(withTp, modify(withTp, 1.1, "1.13")), "PROTECTIVE_GEOMETRY_INVALID");
  expect("doesNotIncreaseExposure catches TP change on its own", doesNotIncreaseExposure(withTp, modify(withTp, 1.1, 1.125)), "PROTECTIVE_TAKE_PROFIT_CHANGED");
  expect("stop rule precedes TP rule (first failure wins)", evaluateProtectiveGeometry(withTp, modify(withTp, 1.094, 1.125)), "PROTECTIVE_STOP_NOT_TIGHTER");
  expect("SELL TP pinned too", evaluateProtectiveGeometry({ ...SELL, takeProfit: 1.07 }, modify({ ...SELL, takeProfit: 1.07 }, 1.1, 1.075)), "PROTECTIVE_TAKE_PROFIT_CHANGED");
}

// ── 5. CLOSE volume: exact, partial, over, garbage ───────────────────────────
{
  const step = 0.01;
  const vol: Array<[unknown, string]> = [
    [0.1, "OK"],
    [0.1 * (1 + 1e-17), "OK"],
    [0.1 - step, "PROTECTIVE_PARTIAL_NOT_SUPPORTED"],
    [0.1 + step, "PROTECTIVE_WOULD_REVERSE"],
    [0.09, "PROTECTIVE_PARTIAL_NOT_SUPPORTED"],
    [0.11, "PROTECTIVE_WOULD_REVERSE"],
    [0.2, "PROTECTIVE_WOULD_REVERSE"],
    [0, "PROTECTIVE_GEOMETRY_INVALID"],
    [Number.NaN, "PROTECTIVE_GEOMETRY_INVALID"],
    [-0.1, "PROTECTIVE_GEOMETRY_INVALID"],
    ["0.1", "PROTECTIVE_GEOMETRY_INVALID"],
    [Number.POSITIVE_INFINITY, "PROTECTIVE_GEOMETRY_INVALID"],
    [null, "PROTECTIVE_GEOMETRY_INVALID"],
    [undefined, "PROTECTIVE_GEOMETRY_INVALID"],
  ];
  for (const [v, want] of vol) {
    expect(`BUY CLOSE vol ${String(v)} vs 0.10 full geometry`, evaluateProtectiveGeometry(BUY, close(BUY, v)), want);
    expect(`SELL CLOSE vol ${String(v)} vs 0.10 full geometry`, evaluateProtectiveGeometry(SELL, close(SELL, v)), want);
  }
  expect("doesNotIncreaseExposure: partial", doesNotIncreaseExposure(BUY, close(BUY, 0.09)), "PROTECTIVE_PARTIAL_NOT_SUPPORTED");
  expect("doesNotIncreaseExposure: over-volume flips exposure", doesNotIncreaseExposure(BUY, close(BUY, 0.11)), "PROTECTIVE_WOULD_REVERSE");
  expect("doesNotIncreaseExposure: exact passes", doesNotIncreaseExposure(BUY, close(BUY, 0.1)), "OK");
  expect("doesNotReverse: over-volume", doesNotReverse(BUY, close(BUY, 0.11)), "PROTECTIVE_WOULD_REVERSE");
  expect("doesNotReverse: partial is not a reversal", doesNotReverse(BUY, close(BUY, 0.09)), "OK");
  expect("doesNotReverse: exact passes", doesNotReverse(BUY, close(BUY, 0.1)), "OK");
  expect("doesNotReverse: MODIFY never reverses", doesNotReverse(BUY, modify(BUY, 1.1)), "OK");
  expect("volume within float tolerance of a large lot passes", evaluateProtectiveGeometry({ ...BUY, volume: 50 }, close({ ...BUY, volume: 50 }, 50 * (1 + 1e-16))), "OK");
  expect("volume one step above a large lot still reverses", evaluateProtectiveGeometry({ ...BUY, volume: 50 }, close({ ...BUY, volume: 50 }, 50.01)), "PROTECTIVE_WOULD_REVERSE");
}

// ── 6. Side: same, opposite, lowercase, LONG ─────────────────────────────────
{
  expect("CLOSE SELL vs BUY position", evaluateProtectiveGeometry(BUY, close(BUY, 0.1, "SELL")), "PROTECTIVE_SIDE_MISMATCH");
  expect("CLOSE BUY vs SELL position", evaluateProtectiveGeometry(SELL, close(SELL, 0.1, "BUY")), "PROTECTIVE_SIDE_MISMATCH");
  expect("CLOSE 'buy' (lowercase) is shape-invalid", evaluateProtectiveGeometry(BUY, close(BUY, 0.1, "buy")), "PROTECTIVE_GEOMETRY_INVALID");
  expect("CLOSE 'LONG' is shape-invalid", evaluateProtectiveGeometry(BUY, close(BUY, 0.1, "LONG")), "PROTECTIVE_GEOMETRY_INVALID");
  expect("CLOSE side missing is shape-invalid", evaluateProtectiveGeometry(BUY, { kind: "CLOSE", volume: 0.1 } as unknown as ProtectiveIntent), "PROTECTIVE_GEOMETRY_INVALID");
  expect("MODIFY on the wrong side refuses", evaluateProtectiveGeometry(BUY, { ...modify(BUY, 1.1), side: "SELL" } as ProtectiveIntent), "PROTECTIVE_SIDE_MISMATCH");
  expect("side mismatch precedes volume (order)", evaluateProtectiveGeometry(BUY, close(BUY, 0.5, "SELL")), "PROTECTIVE_SIDE_MISMATCH");
  expect("doesNotReverse names the side", doesNotReverse(BUY, close(BUY, 0.1, "SELL")), "PROTECTIVE_SIDE_MISMATCH");
  expect("doesNotIncreaseExposure names the side", doesNotIncreaseExposure(BUY, close(BUY, 0.1, "SELL")), "PROTECTIVE_SIDE_MISMATCH");
  // Position side itself must be exactly BUY/SELL.
  expect("position side 'buy' is shape-invalid", evaluateProtectiveGeometry({ ...BUY, side: "buy" as "BUY" }, close(BUY)), "PROTECTIVE_GEOMETRY_INVALID");
  expect("position side 'LONG' is shape-invalid", evaluateProtectiveGeometry({ ...BUY, side: "LONG" as "BUY" }, close(BUY)), "PROTECTIVE_GEOMETRY_INVALID");
}

// ── 7. Adversarial intents and positions ─────────────────────────────────────
{
  const bad: Array<[string, unknown]> = [
    ["kind OPEN", { kind: "OPEN", side: "BUY", volume: 0.1 }],
    ["kind REVERSE", { kind: "REVERSE", side: "BUY", volume: 0.1 }],
    ["kind CLOSE_BY", { kind: "CLOSE_BY", side: "BUY", volume: 0.1 }],
    ["kind lowercase close", { kind: "close", side: "BUY", volume: 0.1 }],
    ["CLOSE with closeVolume", { kind: "CLOSE", side: "BUY", volume: 0.1, closeVolume: 0.05 }],
    ["CLOSE with newTakeProfit", { kind: "CLOSE", side: "BUY", volume: 0.1, newTakeProfit: null }],
    ["CLOSE with newStopLoss", { kind: "CLOSE", side: "BUY", volume: 0.1, newStopLoss: 1.1 }],
    ["CLOSE missing volume", { kind: "CLOSE", side: "BUY" }],
    ["MODIFY with volume", { kind: "MODIFY_STOP", side: "BUY", newStopLoss: 1.1, newTakeProfit: null, volume: 0.1 }],
    ["MODIFY missing newTakeProfit (must be explicit)", { kind: "MODIFY_STOP", side: "BUY", newStopLoss: 1.1 }],
    ["MODIFY missing newStopLoss", { kind: "MODIFY_STOP", side: "BUY", newTakeProfit: null }],
    ["MODIFY with extra key", { kind: "MODIFY_STOP", side: "BUY", newStopLoss: 1.1, newTakeProfit: null, symbol: "EURUSD" }],
    ["null intent", null],
    ["undefined intent", undefined],
    ["string intent", "CLOSE"],
    ["array intent", ["CLOSE"]],
    ["empty object", {}],
    ["kind missing", { side: "BUY", volume: 0.1 }],
  ];
  for (const [label, intent] of bad) {
    expect(`adversarial intent: ${label}`, evaluateProtectiveGeometry(BUY, intent as ProtectiveIntent), "PROTECTIVE_GEOMETRY_INVALID");
    expect(`adversarial intent (exposure): ${label}`, doesNotIncreaseExposure(BUY, intent as ProtectiveIntent), "PROTECTIVE_GEOMETRY_INVALID");
    expect(`adversarial intent (reverse): ${label}`, doesNotReverse(BUY, intent as ProtectiveIntent), "PROTECTIVE_GEOMETRY_INVALID");
    expect(`adversarial intent (stop): ${label}`, doesNotLoosenStop(BUY, intent as ProtectiveIntent), "PROTECTIVE_GEOMETRY_INVALID");
  }
  // Frozen and prototype-less objects behave like plain ones.
  const frozen = Object.freeze({ kind: "CLOSE", side: "BUY", volume: 0.1 }) as ProtectiveIntent;
  expect("frozen CLOSE intent passes", evaluateProtectiveGeometry(BUY, frozen), "OK");
  const bare = Object.assign(Object.create(null), { kind: "MODIFY_STOP", side: "BUY", newStopLoss: 1.1, newTakeProfit: null }) as ProtectiveIntent;
  expect("prototype-less MODIFY intent passes", evaluateProtectiveGeometry(BUY, bare), "OK");
  const bareBad = Object.assign(Object.create(null), { kind: "MODIFY_STOP", side: "BUY", newStopLoss: 1.094, newTakeProfit: null }) as ProtectiveIntent;
  expect("prototype-less loosening MODIFY refuses", evaluateProtectiveGeometry(BUY, bareBad), "PROTECTIVE_STOP_NOT_TIGHTER");
  const frozenPos = Object.freeze({ ...BUY });
  expect("frozen position facts work", evaluateProtectiveGeometry(frozenPos, close(frozenPos)), "OK");
  // Position facts that cannot anchor a decision.
  const badPos: Array<[string, unknown]> = [
    ["volume 0", { ...BUY, volume: 0 }],
    ["volume NaN", { ...BUY, volume: Number.NaN }],
    ["volume string", { ...BUY, volume: "0.1" }],
    ["entryPrice 0", { ...BUY, entryPrice: 0 }],
    ["currentPrice null", { ...BUY, currentPrice: null }],
    ["currentPrice NaN", { ...BUY, currentPrice: Number.NaN }],
    ["currentPrice string", { ...BUY, currentPrice: "1.112" }],
    ["stopLoss NaN", { ...BUY, stopLoss: Number.NaN }],
    ["stopLoss 0 (unparsed broker zero)", { ...BUY, stopLoss: 0 }],
    ["takeProfit 0 (unparsed broker zero)", { ...BUY, takeProfit: 0 }],
    ["takeProfit string", { ...BUY, takeProfit: "1.13" }],
    ["null position", null],
    ["array position", [BUY]],
  ];
  for (const [label, pos] of badPos) {
    expect(`adversarial position: ${label}`, evaluateProtectiveGeometry(pos as ProtectivePositionFacts, close(BUY)), "PROTECTIVE_GEOMETRY_INVALID");
  }
  // Inputs are never mutated.
  const posCopy = { ...BUY };
  const intentCopy = modify(BUY, 1.1);
  evaluateProtectiveGeometry(posCopy, intentCopy);
  check("position facts not mutated", JSON.stringify(posCopy) === JSON.stringify(BUY));
  check("intent not mutated", JSON.stringify(intentCopy) === JSON.stringify(modify(BUY, 1.1)));
}

// ── 8. Hold reasons and plain-English text ───────────────────────────────────
{
  check("hold reason list is non-empty and unique", PROTECTIVE_HOLD_REASONS.length >= 40 && new Set(PROTECTIVE_HOLD_REASONS).size === PROTECTIVE_HOLD_REASONS.length, String(PROTECTIVE_HOLD_REASONS.length));
  const poison = {
    login: "12345", server: "Broker-Live", mode: "LIVE", accountType: "live", expectedLogin: "12345", expectedCompany: "Broker Co",
    apiKeyHash: "deadbeef", previousApiKeyHash: "cafebabe", bridgeToken: "tok_secret", token: "secret-token", sources: ["platform_emergency_stop"],
    ageSec: 61, ageMs: 91000, waitedSec: 20, heldAt: "2026-10-27T12:00:00.000Z", observedAt: "2026-10-27T12:00:01.000Z", eventAt: "2026-10-27T12:00:02.000Z",
    ticket: "123", count: 2, firstAbsentAt: "2026-10-27T11:59:00.000Z", field: "symbol", expected: "EURUSD", observed: "EURUSD.r", p: 1.112, inv: 1.09,
    trigger: "EXIT_INVALIDATION", action: "MODIFY_STOP", newSl: 1.1, pipelineReason: "USER_NOT_ARMED_FOR_LIVE", message: "boom", detail: "currentPrice=NaN", ms: 31000,
  };
  for (const r of PROTECTIVE_HOLD_REASONS) {
    const text = explainProtectiveHold(r, poison);
    check(`${r} has plain-English text`, typeof text === "string" && text.trim().length > 20 && !/\{[a-zA-Z]+\}/.test(text), text);
    check(`${r} text never leaks token material`, !/deadbeef|cafebabe|tok_secret|secret-token|apiKeyHash/i.test(text), text);
    const redacted = JSON.stringify(redactProtectiveDetail(poison));
    check(`${r} redacted detail has no apiKeyHash/token substring`, !/apiKeyHash|token|deadbeef|cafebabe/i.test(redacted), redacted);
  }
  check("unknown reason still explains safely", explainProtectiveHold("SOMETHING_ELSE" as never, {}).length > 10);
  check("empty detail leaves no raw placeholder", !/\{[a-zA-Z]+\}/.test(explainProtectiveHold("PROTECTIVE_HOLD_NO_FRESH_SWEEP", {})));
  check("NO_FRESH_SWEEP text names manual controls and broker stop",
    /manual/i.test(explainProtectiveHold("PROTECTIVE_HOLD_NO_FRESH_SWEEP", poison)) && /broker/i.test(explainProtectiveHold("PROTECTIVE_HOLD_NO_FRESH_SWEEP", poison)));
  check("PLATFORM_STOP text names the admin emergency close", /emergency/i.test(explainProtectiveHold("PROTECTIVE_HOLD_PLATFORM_STOP_ENGAGED", poison)));
  check("identity text carries field/expected/observed", /symbol.*EURUSD.*EURUSD\.r/.test(explainProtectiveHold("PROTECTIVE_IDENTITY_SYMBOL_MISMATCH", poison)));
  check("redaction keeps operator-useful fields", (redactProtectiveDetail(poison) as { login?: unknown }).login === "12345");
  check("redaction drops nested token material", !/secret/.test(JSON.stringify(redactProtectiveDetail({ nested: { bridgeToken: "secret", ok: 1 } }))));
}

// ── 9. Identity — bridge ─────────────────────────────────────────────────────
const entry: ProtectiveEntryFacts = {
  commandId: "entry-1", userId: 9, bridgeConnectionId: 12, accountLogin: "12345", brokerServer: "Broker Co",
  brokerTicket: "123", symbol: "EURUSD", requestedVolume: 0.1, executedVolume: 0.1,
};
const execution: ProtectiveExecutionFacts = { executingUserId: 9, brokerTicket: "123", side: "BUY", intendedVolume: 0.1 };
const bridge: ProtectiveBridgeFacts = {
  id: 12, userId: 9, accountNumber: "12345", brokerName: "Broker Co", serverName: "Broker-Live", tokenRevokedAt: null, status: "connected",
  hasBridgeToken: true, accountType: "live", mode: "LIVE", capabilities: { supportsManagementTargetV1: true },
};
{
  expect("bridge: baseline verifies", verifyProtectiveBridge(entry, execution, bridge, "fresh"), "OK");
  expect("bridge: degraded heartbeat is still online", verifyProtectiveBridge(entry, execution, bridge, "degraded"), "OK");
  expect("bridge: null connection", verifyProtectiveBridge(entry, execution, null, "fresh"), "PROTECTIVE_BRIDGE_UNVERIFIED");
  expect("bridge: different connection id", verifyProtectiveBridge(entry, execution, { ...bridge, id: 13 }, "fresh"), "PROTECTIVE_BRIDGE_UNVERIFIED");
  expect("bridge: entry without a bridge id", verifyProtectiveBridge({ ...entry, bridgeConnectionId: null }, execution, bridge, "fresh"), "PROTECTIVE_BRIDGE_UNVERIFIED");
  expect("bridge: other owner", verifyProtectiveBridge(entry, execution, { ...bridge, userId: 8 }, "fresh"), "PROTECTIVE_BRIDGE_OWNER_MISMATCH");
  expect("bridge: null owner", verifyProtectiveBridge(entry, execution, { ...bridge, userId: null }, "fresh"), "PROTECTIVE_BRIDGE_OWNER_MISMATCH");
  expect("bridge: execution without executing user", verifyProtectiveBridge(entry, { ...execution, executingUserId: null }, bridge, "fresh"), "PROTECTIVE_BRIDGE_OWNER_MISMATCH");
  expect("bridge: login changed", verifyProtectiveBridge(entry, execution, { ...bridge, accountNumber: "99999" }, "fresh"), "PROTECTIVE_BRIDGE_ACCOUNT_MISMATCH");
  expect("bridge: login null", verifyProtectiveBridge(entry, execution, { ...bridge, accountNumber: null }, "fresh"), "PROTECTIVE_BRIDGE_ACCOUNT_MISMATCH");
  expect("bridge: company changed", verifyProtectiveBridge(entry, execution, { ...bridge, brokerName: "Other Co" }, "fresh"), "PROTECTIVE_BRIDGE_ACCOUNT_MISMATCH");
  expect("bridge: serverName empty", verifyProtectiveBridge(entry, execution, { ...bridge, serverName: "" }, "fresh"), "PROTECTIVE_BRIDGE_ACCOUNT_MISMATCH");
  expect("bridge: serverName whitespace", verifyProtectiveBridge(entry, execution, { ...bridge, serverName: "   " }, "fresh"), "PROTECTIVE_BRIDGE_ACCOUNT_MISMATCH");
  expect("bridge: serverName null", verifyProtectiveBridge(entry, execution, { ...bridge, serverName: null }, "fresh"), "PROTECTIVE_BRIDGE_ACCOUNT_MISMATCH");
  expect("bridge: serverName changed is still an account (server) match question, allowed here (pinned later by the target)", verifyProtectiveBridge(entry, execution, { ...bridge, serverName: "Broker-Live2" }, "fresh"), "OK");
  expect("bridge: token revoked", verifyProtectiveBridge(entry, execution, { ...bridge, tokenRevokedAt: new Date() }, "fresh"), "PROTECTIVE_BRIDGE_REVOKED");
  expect("bridge: status revoked", verifyProtectiveBridge(entry, execution, { ...bridge, status: "revoked" }, "fresh"), "PROTECTIVE_BRIDGE_REVOKED");
  expect("bridge: no token issued", verifyProtectiveBridge(entry, execution, { ...bridge, hasBridgeToken: false }, "fresh"), "PROTECTIVE_BRIDGE_REVOKED");
  expect("bridge: MOCK mode", verifyProtectiveBridge(entry, execution, { ...bridge, mode: "MOCK" }, "fresh"), "PROTECTIVE_BRIDGE_NOT_LIVE");
  expect("bridge: demo account", verifyProtectiveBridge(entry, execution, { ...bridge, accountType: "demo" }, "fresh"), "PROTECTIVE_BRIDGE_NOT_LIVE");
  expect("bridge: unknown account type", verifyProtectiveBridge(entry, execution, { ...bridge, accountType: "unknown" }, "fresh"), "PROTECTIVE_BRIDGE_NOT_LIVE");
  expect("bridge: null account type", verifyProtectiveBridge(entry, execution, { ...bridge, accountType: null }, "fresh"), "PROTECTIVE_BRIDGE_NOT_LIVE");
  expect("bridge: 'real' account type is live", verifyProtectiveBridge(entry, execution, { ...bridge, accountType: "real" }, "fresh"), "OK");
  expect("bridge: 'LIVE' account type (case) is live", verifyProtectiveBridge(entry, execution, { ...bridge, accountType: "LIVE" }, "fresh"), "OK");
  expect("bridge: offline heartbeat", verifyProtectiveBridge(entry, execution, bridge, "offline"), "PROTECTIVE_BRIDGE_OFFLINE");
  expect("bridge: unknown heartbeat", verifyProtectiveBridge(entry, execution, bridge, "unknown"), "PROTECTIVE_BRIDGE_OFFLINE");
  expect("bridge: capabilities missing", verifyProtectiveBridge(entry, execution, { ...bridge, capabilities: null }, "fresh"), "PROTECTIVE_HOLD_TERMINAL_UPGRADE_REQUIRED");
  expect("bridge: capabilities false", verifyProtectiveBridge(entry, execution, { ...bridge, capabilities: { supportsManagementTargetV1: false } }, "fresh"), "PROTECTIVE_HOLD_TERMINAL_UPGRADE_REQUIRED");
  expect("bridge: capabilities string 'true'", verifyProtectiveBridge(entry, execution, { ...bridge, capabilities: { supportsManagementTargetV1: "true" } }, "fresh"), "PROTECTIVE_HOLD_TERMINAL_UPGRADE_REQUIRED");
  expect("bridge: capabilities array", verifyProtectiveBridge(entry, execution, { ...bridge, capabilities: [true] }, "fresh"), "PROTECTIVE_HOLD_TERMINAL_UPGRADE_REQUIRED");
  expect("bridge: capabilities empty object", verifyProtectiveBridge(entry, execution, { ...bridge, capabilities: {} }, "fresh"), "PROTECTIVE_HOLD_TERMINAL_UPGRADE_REQUIRED");
  expect("bridge: order — owner before account", verifyProtectiveBridge(entry, execution, { ...bridge, userId: 8, accountNumber: "1" }, "offline"), "PROTECTIVE_BRIDGE_OWNER_MISMATCH");
  expect("bridge: order — revoked before not-live", verifyProtectiveBridge(entry, execution, { ...bridge, status: "revoked", mode: "MOCK" }, "fresh"), "PROTECTIVE_BRIDGE_REVOKED");
  expect("bridge: order — offline before capability", verifyProtectiveBridge(entry, execution, { ...bridge, capabilities: null }, "offline"), "PROTECTIVE_BRIDGE_OFFLINE");
  const v = verifyProtectiveBridge(entry, execution, { ...bridge, accountNumber: "99999" }, "fresh");
  check("bridge mismatch detail carries login/server/expected", !v.ok && v.detail.login === "99999" && v.detail.expectedLogin === "12345" && v.detail.expectedCompany === "Broker Co");
}

// ── 10. Identity — position row ──────────────────────────────────────────────
const row: ProtectiveRowFacts = {
  id: 1, userId: 9, bridgeConnectionId: 12, accountLogin: "12345", brokerServer: "Broker Co", brokerTicket: "123",
  sourceCommandId: "entry-1", symbol: "EURUSD", side: "BUY", volume: 0.1,
};
{
  expect("row: baseline verifies", verifyProtectivePosition(execution, entry, row), "OK");
  expect("row: missing", verifyProtectivePosition(execution, entry, null), "PROTECTIVE_IDENTITY_ROW_MISSING");
  expect("row: undefined", verifyProtectivePosition(execution, entry, undefined), "PROTECTIVE_IDENTITY_ROW_MISSING");
  expect("row: other user", verifyProtectivePosition(execution, entry, { ...row, userId: 8 }), "PROTECTIVE_IDENTITY_OWNER_MISMATCH");
  expect("row: entry other user", verifyProtectivePosition(execution, { ...entry, userId: 8 }, row), "PROTECTIVE_IDENTITY_OWNER_MISMATCH");
  expect("row: execution without user", verifyProtectivePosition({ ...execution, executingUserId: null }, entry, row), "PROTECTIVE_IDENTITY_OWNER_MISMATCH");
  expect("row: other bridge", verifyProtectivePosition(execution, entry, { ...row, bridgeConnectionId: 13 }), "PROTECTIVE_IDENTITY_ACCOUNT_MISMATCH");
  expect("row: other login", verifyProtectivePosition(execution, entry, { ...row, accountLogin: "99999" }), "PROTECTIVE_IDENTITY_ACCOUNT_MISMATCH");
  expect("row: other company", verifyProtectivePosition(execution, entry, { ...row, brokerServer: "Other Co" }), "PROTECTIVE_IDENTITY_ACCOUNT_MISMATCH");
  expect("row: entry login blank", verifyProtectivePosition(execution, { ...entry, accountLogin: " " }, { ...row, accountLogin: " " }), "PROTECTIVE_IDENTITY_ACCOUNT_MISMATCH");
  expect("row: entry bridge id 0", verifyProtectivePosition(execution, { ...entry, bridgeConnectionId: 0 }, { ...row, bridgeConnectionId: 0 }), "PROTECTIVE_IDENTITY_ACCOUNT_MISMATCH");
  expect("row: ticket differs", verifyProtectivePosition(execution, entry, { ...row, brokerTicket: "124" }), "PROTECTIVE_IDENTITY_TICKET_MISMATCH");
  expect("row: entry ticket differs", verifyProtectivePosition(execution, { ...entry, brokerTicket: "124" }, row), "PROTECTIVE_IDENTITY_TICKET_MISMATCH");
  expect("row: execution ticket null", verifyProtectivePosition({ ...execution, brokerTicket: null }, entry, row), "PROTECTIVE_IDENTITY_TICKET_MISMATCH");
  expect("row: sourceCommandId null", verifyProtectivePosition(execution, entry, { ...row, sourceCommandId: null }), "PROTECTIVE_IDENTITY_SOURCE_COMMAND_MISMATCH");
  expect("row: sourceCommandId other", verifyProtectivePosition(execution, entry, { ...row, sourceCommandId: "entry-2" }), "PROTECTIVE_IDENTITY_SOURCE_COMMAND_MISMATCH");
  expect("row: symbol EURUSD.r vs EURUSD", verifyProtectivePosition(execution, entry, { ...row, symbol: "EURUSD.r" }), "PROTECTIVE_IDENTITY_SYMBOL_MISMATCH");
  expect("row: symbol lowercase", verifyProtectivePosition(execution, entry, { ...row, symbol: "eurusd" }), "PROTECTIVE_IDENTITY_SYMBOL_MISMATCH");
  expect("row: decorated entry symbol matches decorated row", verifyProtectivePosition(execution, { ...entry, symbol: "EURUSD.r" }, { ...row, symbol: "EURUSD.r" }), "OK");
  expect("row: side flipped", verifyProtectivePosition(execution, entry, { ...row, side: "SELL" }), "PROTECTIVE_IDENTITY_SIDE_MISMATCH");
  expect("row: side lowercase", verifyProtectivePosition(execution, entry, { ...row, side: "buy" }), "PROTECTIVE_IDENTITY_SIDE_MISMATCH");
  expect("row: volume halved", verifyProtectivePosition(execution, entry, { ...row, volume: 0.05 }), "PROTECTIVE_IDENTITY_VOLUME_CHANGED");
  expect("row: volume grown", verifyProtectivePosition(execution, entry, { ...row, volume: 0.2 }), "PROTECTIVE_IDENTITY_VOLUME_CHANGED");
  expect("row: volume +tol passes", verifyProtectivePosition(execution, entry, { ...row, volume: 0.1 * (1 + 1e-16) }), "OK");
  expect("row: volume −tol passes", verifyProtectivePosition(execution, entry, { ...row, volume: 0.1 * (1 - 1e-16) }), "OK");
  expect("row: volume one broker step off refuses", verifyProtectivePosition(execution, entry, { ...row, volume: 0.11 }), "PROTECTIVE_IDENTITY_VOLUME_CHANGED");
  expect("row: entry executed volume short (partial entry)", verifyProtectivePosition(execution, { ...entry, executedVolume: 0.05 }, row), "PROTECTIVE_IDENTITY_VOLUME_CHANGED");
  expect("row: entry requested volume null", verifyProtectivePosition(execution, { ...entry, requestedVolume: null }, row), "PROTECTIVE_IDENTITY_VOLUME_CHANGED");
  expect("row: volume NaN", verifyProtectivePosition(execution, entry, { ...row, volume: Number.NaN }), "PROTECTIVE_IDENTITY_VOLUME_CHANGED");
  expect("row: order — owner before ticket", verifyProtectivePosition(execution, entry, { ...row, userId: 8, brokerTicket: "9" }), "PROTECTIVE_IDENTITY_OWNER_MISMATCH");
  expect("row: order — account before symbol", verifyProtectivePosition(execution, entry, { ...row, accountLogin: "1", symbol: "X" }), "PROTECTIVE_IDENTITY_ACCOUNT_MISMATCH");
  const v = verifyProtectivePosition(execution, entry, { ...row, symbol: "EURUSD.r" });
  check("row mismatch detail names field/expected/observed", !v.ok && v.detail.field === "symbol" && v.detail.expected === "EURUSD" && v.detail.observed === "EURUSD.r");
  const vol = verifyProtectivePosition(execution, entry, { ...row, volume: 0.05 });
  check("volume change detail carries both sizes", !vol.ok && vol.detail.observed === 0.05 && vol.detail.expected === 0.1);
}

// ── 11. Micro-benchmark (informational; never a pass/fail gate) ──────────────
{
  const n = 10_000;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) evaluateProtectiveGeometry(BUY, modify(BUY, 1.1));
  const geometryUs = ((performance.now() - t0) / n) * 1000;
  const t1 = performance.now();
  for (let i = 0; i < n; i++) verifyProtectivePosition(execution, entry, row);
  const identityUs = ((performance.now() - t1) / n) * 1000;
  const t2 = performance.now();
  for (let i = 0; i < n; i++) verifyProtectiveBridge(entry, execution, bridge, "fresh");
  const bridgeUs = ((performance.now() - t2) / n) * 1000;
  console.log(
    `PROTECTIVE_DOMAIN_BENCHMARK n=${n}: geometry ${geometryUs.toFixed(3)} µs, position identity ${identityUs.toFixed(3)} µs, bridge identity ${bridgeUs.toFixed(3)} µs per call`,
  );
  check("predicates are pure and cheap (< 50 µs each, generous for a loaded host)", geometryUs < 50 && identityUs < 50 && bridgeUs < 50, `${geometryUs} ${identityUs} ${bridgeUs}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
