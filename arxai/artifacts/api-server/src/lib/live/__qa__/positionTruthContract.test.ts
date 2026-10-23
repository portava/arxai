// Live-Position Truth contract (Phase 1) — deterministic lock.
//
// Proves the backend is the SINGLE source of truth for what counts as a verified
// live MT5 position, that advice is ALLOWED only on a fully verified live row,
// and that the resolver is BLOCK-ONLY — it can only withhold advice, never grant
// trade permission. Pure (no DB, no I/O): the resolver and the row→input mapping
// are both deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePositionTruth,
  mayAdviseOnPosition,
  type PositionTruthInput,
} from "@workspace/domain/live-position";
import {
  truthInputFromLivePosition,
  truthInputFromAttribution,
  classifyLivePosition,
  classifyAttribution,
  splitByTruth,
} from "../positionTruthAdapter.js";
import type { LivePosition, SharedTradeAttributionRow } from "@workspace/db/schema";

const NOW = 1_700_000_000_000;

// A fully verified open live position input.
function verifiedInput(over: Partial<PositionTruthInput> = {}): PositionTruthInput {
  return {
    rowKind: "live_position",
    brokerTicket: "123456789",
    symbol: "EURUSD",
    side: "BUY",
    volume: 0.1,
    entryPrice: 1.085,
    currentPrice: 1.0861,
    unrealizedPnl: 11,
    bridgeAccountSource: "user_owned_mt5",
    openedAtMs: NOW - 60_000,
    lastUpdateAtMs: NOW - 5_000,
    freshness: "FRESH",
    attributionConfirmed: true,
    closed: false,
    ...over,
  };
}

// ── Scenario 1 — verified live position: advice ALLOWED ──────────────────────
test("verified_live_position — all fields fresh + attributed → advice allowed", () => {
  const v = resolvePositionTruth(verifiedInput());
  assert.equal(v.category, "verified_live_position");
  assert.equal(v.badge, "VERIFIED_LIVE");
  assert.equal(v.isVerifiedLive, true);
  assert.equal(v.brokerConfirmed, true);
  assert.equal(v.countsTowardExposure, true);
  assert.equal(v.adviceAllowed, true);
  assert.deepEqual(v.missingFields, []);
  assert.equal(mayAdviseOnPosition(v), true);
});

// ── Scenario 2 — broker ticket but lagging data: exposure yes, advice NO ──────
test("attributed_but_incomplete — ticket present, missing current price → counts toward exposure, advice withheld", () => {
  const v = resolvePositionTruth(verifiedInput({ currentPrice: null, unrealizedPnl: null }));
  assert.equal(v.category, "attributed_but_incomplete_position");
  assert.equal(v.isVerifiedLive, false);
  assert.equal(v.brokerConfirmed, true);
  assert.equal(v.countsTowardExposure, true); // real broker exposure
  assert.equal(v.adviceAllowed, false);
  assert.ok(v.missingFields.includes("currentPrice"));
  assert.equal(mayAdviseOnPosition(v), false);
});

// ── Scenario 3 — stale snapshot: incomplete with STALE badge ─────────────────
test("attributed_but_incomplete — stale freshness → STALE badge, advice withheld", () => {
  const v = resolvePositionTruth(verifiedInput({ freshness: "STALE" }));
  assert.equal(v.category, "attributed_but_incomplete_position");
  assert.equal(v.badge, "STALE");
  assert.equal(v.adviceAllowed, false);
  assert.ok(v.missingFields.includes("freshness"));
});

// ── Scenario 4 — no broker ticket: unsynced, excluded from totals ────────────
test("unsynced_unknown — no broker ticket → excluded from exposure, advice withheld", () => {
  const v = resolvePositionTruth(verifiedInput({ brokerTicket: null }));
  assert.equal(v.category, "unsynced_unknown");
  assert.equal(v.badge, "UNSYNCED");
  assert.equal(v.brokerConfirmed, false);
  assert.equal(v.countsTowardExposure, false); // never counted in totals
  assert.equal(v.adviceAllowed, false);
});

// ── Scenario 5 — scanner signal is never a position ──────────────────────────
test("scanner_signal — never a held position, never advisable as a trade", () => {
  const v = resolvePositionTruth(verifiedInput({ rowKind: "scanner_signal" }));
  assert.equal(v.category, "scanner_signal");
  assert.equal(v.isVerifiedLive, false);
  assert.equal(v.countsTowardExposure, false);
  assert.equal(v.adviceAllowed, false);
});

// ── Scenario 6 — pending order is not filled → not a live position ───────────
test("pending_order — not filled at broker → advice withheld, no exposure", () => {
  const v = resolvePositionTruth(verifiedInput({ rowKind: "pending_order" }));
  assert.equal(v.category, "pending_order");
  assert.equal(v.countsTowardExposure, false);
  assert.equal(v.adviceAllowed, false);
});

// ── Scenario 7 — closed/terminal row is history ──────────────────────────────
test("historical_closed — closed row is never a current position", () => {
  const v = resolvePositionTruth(verifiedInput({ closed: true }));
  assert.equal(v.category, "historical_closed");
  assert.equal(v.countsTowardExposure, false);
  assert.equal(v.adviceAllowed, false);
});

// ── No-gate-bypass regression — adviceAllowed can NEVER be true unless verified ─
test("no-bypass — adviceAllowed/mayAdvise is true ONLY for a verified live position", () => {
  const kinds: PositionTruthInput[] = [
    verifiedInput({ rowKind: "scanner_signal" }),
    verifiedInput({ rowKind: "pending_order" }),
    verifiedInput({ closed: true }),
    verifiedInput({ brokerTicket: null }),
    verifiedInput({ currentPrice: null, unrealizedPnl: null }),
    verifiedInput({ freshness: "STALE" }),
    verifiedInput({ attributionConfirmed: false }),
    verifiedInput({ side: "LONG" }), // invalid side token
    verifiedInput({ volume: 0 }),
    verifiedInput({ entryPrice: null }),
  ];
  for (const input of kinds) {
    const v = resolvePositionTruth(input);
    assert.equal(v.isVerifiedLive, false, `${JSON.stringify(input)} must not verify`);
    assert.equal(v.adviceAllowed, false, "advice must be withheld on a non-verified row");
    assert.equal(mayAdviseOnPosition(v), false);
  }
  // And the one truly verified row is the only one that flips advice on.
  const ok = resolvePositionTruth(verifiedInput());
  assert.equal(ok.adviceAllowed, true);
  assert.equal(mayAdviseOnPosition(ok), true);
});

// ── Adapter row→input mapping (USER_OWNED_MT5 live_positions) ─────────────────
function liveRow(over: Partial<LivePosition> = {}): LivePosition {
  return {
    id: 1,
    userId: 42,
    tradeId: null,
    brokerPositionId: "987654321",
    symbol: "EURUSD",
    direction: "BUY",
    lotSize: 0.2,
    entryPrice: 1.1,
    currentPrice: 1.101,
    stopLoss: 1.09,
    takeProfit: 1.12,
    unrealizedProfitLoss: 20,
    realizedProfitLoss: null,
    rewardToRisk: null,
    status: "OPEN",
    openedAt: new Date(NOW - 120_000),
    closedAt: null,
    lastSyncedAt: new Date(NOW - 4_000),
    createdAt: new Date(NOW - 120_000),
    updatedAt: new Date(NOW - 4_000),
    ...over,
  } as LivePosition;
}

test("adapter — user-owned fresh row maps to a verified live position", () => {
  const v = classifyLivePosition(liveRow(), { snapshotReliable: true, now: NOW });
  assert.equal(v.category, "verified_live_position");
  assert.equal(v.isVerifiedLive, true);
});

test("adapter — user-owned row without broker ticket is unsynced (no advice, no exposure)", () => {
  const v = classifyLivePosition(liveRow({ brokerPositionId: null }), { snapshotReliable: true, now: NOW });
  assert.equal(v.category, "unsynced_unknown");
  assert.equal(v.adviceAllowed, false);
  assert.equal(v.countsTowardExposure, false);
});

test("adapter — user-owned row lagging current price counts as exposure but withholds advice", () => {
  const v = classifyLivePosition(liveRow({ currentPrice: null, unrealizedProfitLoss: null }), {
    snapshotReliable: true,
    now: NOW,
  });
  assert.equal(v.category, "attributed_but_incomplete_position");
  assert.equal(v.countsTowardExposure, true);
  assert.equal(v.adviceAllowed, false);
});

test("adapter — mapping carries rowKind + ticket through to the input", () => {
  const input = truthInputFromLivePosition(liveRow(), { snapshotReliable: true, now: NOW });
  assert.equal(input.rowKind, "live_position");
  assert.equal(input.brokerTicket, "987654321");
  assert.equal(input.attributionConfirmed, true); // userId present
});

// ── Adapter row→input mapping (SHARED_MASTER_MT5 attribution) ─────────────────
function attRow(over: Partial<SharedTradeAttributionRow> = {}): SharedTradeAttributionRow {
  return {
    id: 5,
    userId: 42,
    virtualAccountId: 9,
    sharedMasterAccountId: 3,
    masterConnectionId: 11,
    tradeCommandId: 100,
    auditLogId: 200,
    mt5OrderTicket: "555",
    mt5PositionTicket: "777",
    symbol: "XAUUSD",
    side: "SELL",
    lotSize: 0.05,
    entryPrice: 2400,
    closePrice: null,
    stopLoss: 2410,
    takeProfit: 2380,
    pnl: 5,
    fees: 0,
    slippage: 0,
    status: "open",
    rejectionReason: null,
    openedAt: new Date(NOW - 60_000),
    closedAt: null,
    realizedAppliedAt: null,
    createdAt: new Date(NOW - 60_000),
    updatedAt: new Date(NOW - 3_000),
    ...over,
  } as SharedTradeAttributionRow;
}

test("adapter — shared attribution (netting, no per-user current price) is incomplete: exposure yes, advice withheld", () => {
  // Shared master rows never carry a broker-confirmed per-user current price, so
  // they are intentionally attributed_but_incomplete (honest, conservative).
  const v = classifyAttribution(attRow(), { now: NOW });
  assert.equal(v.category, "attributed_but_incomplete_position");
  assert.equal(v.brokerConfirmed, true);
  assert.equal(v.countsTowardExposure, true);
  assert.equal(v.adviceAllowed, false);
  assert.ok(v.missingFields.includes("currentPrice"));
});

test("adapter — shared attribution without position ticket is unsynced", () => {
  const v = classifyAttribution(attRow({ mt5PositionTicket: null }), { now: NOW });
  assert.equal(v.category, "unsynced_unknown");
  assert.equal(v.countsTowardExposure, false);
  assert.equal(v.adviceAllowed, false);
});

test("adapter — pending-status shared attribution is not attribution-confirmed", () => {
  const input = truthInputFromAttribution(attRow({ status: "pending" }), { now: NOW });
  assert.equal(input.rowKind, "shared_attribution");
  assert.equal(input.attributionConfirmed, false);
});

// ── splitByTruth buckets ─────────────────────────────────────────────────────
test("splitByTruth — routes verified/incomplete/unsynced into distinct buckets", () => {
  const items = [
    { row: "v", verdict: resolvePositionTruth(verifiedInput()) },
    { row: "i", verdict: resolvePositionTruth(verifiedInput({ currentPrice: null, unrealizedPnl: null })) },
    { row: "u", verdict: resolvePositionTruth(verifiedInput({ brokerTicket: null })) },
    { row: "s", verdict: resolvePositionTruth(verifiedInput({ rowKind: "scanner_signal" })) },
  ];
  const split = splitByTruth(items);
  assert.deepEqual(split.verified.map((x) => x.row), ["v"]);
  assert.deepEqual(split.incomplete.map((x) => x.row), ["i"]);
  // Both the no-ticket row and the scanner signal land in unsynced (never advised).
  assert.deepEqual(split.unsynced.map((x) => x.row).sort(), ["s", "u"]);
});
