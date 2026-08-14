// ─────────────────────────────────────────────────────────────────────────
// Phase 2 — verification of the three architect-flagged gaps:
//   C-1  every event carries a top-level `trainingEligible: boolean`
//   C-2  /api/audit/events?tradeId=X matches BOTH payload.tradeId and
//        payload.linkedTradeId
//   C-3  POST /api/audit/correction appends a VAULT_CORRECTION event that
//        references the corrected eventId; original event remains untouched
// ─────────────────────────────────────────────────────────────────────────
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.API_BASE ?? "http://localhost:80";

async function captureDebug(draft) {
  const r = await fetch(`${BASE}/api/audit/_debug/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(draft),
  });
  assert.equal(r.status, 200, `_debug/capture should be 200, got ${r.status}`);
  return r.json();
}

test("C-1 every audit event carries a top-level trainingEligible boolean", async () => {
  const cap = await captureDebug({
    eventType: "TRADE_APPROVED",
    source: "PHASE2_CORRECTION_TEST",
    severity: "INFO",
    payload: { tradeId: "c1-trade-1", symbol: "Volatility 75 Index" },
  });
  assert.equal(cap.ok, true);
  assert.equal(typeof cap.event.trainingEligible, "boolean",
    "sealed event must expose top-level trainingEligible");

  const list = await fetch(`${BASE}/api/audit/events?source=PHASE2_CORRECTION_TEST&limit=50`).then(r => r.json());
  assert.ok(list.events.length >= 1);
  for (const e of list.events) {
    assert.equal(typeof e.trainingEligible, "boolean",
      `every persisted event must carry top-level trainingEligible — missing on ${e.eventId}`);
  }
});

test("C-2 tradeId filter matches both payload.tradeId and payload.linkedTradeId", async () => {
  const tid = `c2-${Date.now().toString(36)}`;
  await captureDebug({
    eventType: "TRADE_APPROVED", source: "PHASE2_CORRECTION_TEST", severity: "INFO",
    payload: { tradeId: tid, note: "uses tradeId" },
  });
  await captureDebug({
    eventType: "TRADE_BLOCKED", source: "PHASE2_CORRECTION_TEST", severity: "WARN",
    payload: { linkedTradeId: tid, note: "uses linkedTradeId" },
  });

  const r = await fetch(`${BASE}/api/audit/events?tradeId=${tid}&limit=50`).then(r => r.json());
  assert.ok(r.count >= 2, `expected both events to match, got ${r.count}`);
  const types = new Set(r.events.map(e => e.eventType));
  assert.ok(types.has("TRADE_APPROVED"), "tradeId variant should match");
  assert.ok(types.has("TRADE_BLOCKED"), "linkedTradeId variant should match");
});

test("C-2b tradeId filter uses true OR — matches when only linkedTradeId is the queried id", async () => {
  // Event has BOTH keys: tradeId points elsewhere, linkedTradeId is what we query.
  // With `??` semantics the linked id would be hidden by the canonical one and missed.
  const queryId = `c2b-want-${Date.now().toString(36)}`;
  const otherId = `c2b-other-${Date.now().toString(36)}`;
  await captureDebug({
    eventType: "TRADE_REJECTED", source: "PHASE2_CORRECTION_TEST", severity: "WARN",
    payload: { tradeId: otherId, linkedTradeId: queryId, note: "both keys, search by linked" },
  });
  const r = await fetch(`${BASE}/api/audit/events?tradeId=${queryId}&limit=50`).then(r => r.json());
  assert.ok(r.count >= 1, `OR-match must find the event via linkedTradeId, got ${r.count}`);
  assert.ok(r.events.some(e => e.payload.linkedTradeId === queryId));
});

test("C-3 POST /audit/correction appends a VAULT_CORRECTION; original untouched", async () => {
  // 1. Seed an event we will then "correct"
  const original = await captureDebug({
    eventType: "TRADE_APPROVED", source: "PHASE2_CORRECTION_TEST", severity: "INFO",
    payload: { tradeId: "c3-orig", note: "will be corrected" },
  });
  const origId = original.event.eventId;
  const origChecksum = original.event.checksum;

  // 2. Submit correction
  const corrRes = await fetch(`${BASE}/api/audit/correction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      correctsEventId: origId,
      reason: "amended on operator review",
      severity: "WARN",
    }),
  });
  assert.equal(corrRes.status, 200);
  const corr = await corrRes.json();
  assert.equal(corr.ok, true, `correction failed: ${corr.error}`);
  assert.equal(corr.event.eventType, "VAULT_CORRECTION");
  assert.equal(corr.event.payload.correctsEventId, origId);
  assert.equal(corr.event.payload.reason, "amended on operator review");

  // 3. Original event must be untouched (immutable + same checksum)
  const all = await fetch(`${BASE}/api/audit/events?eventType=TRADE_APPROVED&limit=200`).then(r => r.json());
  const refound = all.events.find(e => e.eventId === origId);
  assert.ok(refound, "original event should still be present");
  assert.equal(refound.checksum, origChecksum, "original checksum must not change");

  // 4. Unknown correctsEventId → 404
  const bad = await fetch(`${BASE}/api/audit/correction`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ correctsEventId: "does-not-exist-xyz", reason: "test" }),
  });
  assert.equal(bad.status, 404);
});
