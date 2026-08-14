// ── Bridge v2 ingest → market-data feed wiring test (Task #414) ─────────────
//
// Locks the NEW behavior: an accepted, fresh TICK/CANDLE flowing through the
// real ingest path (ingestBridgeV2Message → tx commit) is ALSO pushed into the
// in-memory mt5Provider store, so the marketDataRouter's top "mt5_broker" slot
// serves broker-native data. This is the activation of the previously-reserved
// MT5 broker chart feed.
//
// Honesty/safety scope (must hold):
//   - ACCEPTED + fresh CANDLE  → series present, router serves mt5_broker.
//   - ACCEPTED + fresh TICK    → quote present + usable.
//   - DUPLICATE (idempotency replay) → NOT fed again (no silent re-stamp).
//   - STALE (>30s transport)   → accepted/traced but NOT fed (an old/replayed
//                                bar must never masquerade as a live feed).
//   - Never touches execution / arx_live_* / positions / balances / 16-gate.
//
// Touches the REAL DB (bridge_v2_events + bridge_v2_stream_state). Uses a
// run-unique NEGATIVE synthetic userId (no FK on user_id) and deletes its rows
// at the end, fail-closed: a leftover synthetic row is reported, never ignored.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { bridgeV2 } from "@workspace/domain";
import {
  ingestBridgeV2Message,
  type BridgeV2IngestInput,
} from "../../artifacts/api-server/src/lib/bridgeV2/ingest.js";
import {
  __resetMt5ProviderStore,
  getMt5SeriesFreshness,
  getMt5QuoteAvailability,
} from "../../artifacts/api-server/src/lib/data/providers/mt5Provider.js";
import { routeCandles } from "../../artifacts/api-server/src/lib/data/marketDataRouter.js";

const { BRIDGE_V2_PROTOCOL_VERSION } = bridgeV2;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: boolean, label: string): void {
  if (cond) passed += 1;
  else {
    failed += 1;
    failures.push(label);
  }
}
function eq<T>(actual: T, expected: T, label: string): void {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// Run-unique so reruns never collide on the idempotency unique index.
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const USER_ID = -Math.floor(1_000_000 + Math.random() * 8_000_000);

function envelope(
  messageType: string,
  payload: unknown,
  over: { sequence: number; idem: string; eaCreatedAtEpochMs?: number; streamKey?: string },
): unknown {
  return {
    protocolVersion: BRIDGE_V2_PROTOCOL_VERSION,
    messageType,
    streamKey: over.streamKey ?? "default",
    sequence: over.sequence,
    idempotencyKey: over.idem,
    eaCreatedAtEpochMs: over.eaCreatedAtEpochMs ?? Date.now(),
    eaVersion: "2.00",
    payload,
  };
}

async function ingest(raw: unknown, eaCreatedAtEpochMs?: number) {
  const now = Date.now();
  const input: BridgeV2IngestInput = {
    userId: USER_ID,
    bridgeConnectionId: null,
    raw,
    serverReceivedAtEpochMs: now,
  };
  // When the message stamped an old eaCreatedAt, keep serverReceivedAt = now so
  // the transport latency (and thus STALE classification) is real.
  void eaCreatedAtEpochMs;
  return ingestBridgeV2Message(input);
}

async function main(): Promise<void> {
  __resetMt5ProviderStore();

  // ── 1. ACCEPTED + fresh CANDLE feeds the provider and wins at the router ──
  {
    const candle = {
      symbol: "EURUSD",
      timeframe: "M5",
      openTimeEpochMs: Date.UTC(2026, 5, 9, 12, 0, 0),
      open: 1.07, high: 1.072, low: 1.069, close: 1.071, volume: 100,
      isClosed: true as const,
    };
    const res = await ingest(envelope("CANDLE", candle, { sequence: 1, idem: `${RUN}-c1` }));
    eq(res.accepted, true, "fresh CANDLE accepted");
    eq(res.freshnessVerdict, "LIVE", "fresh CANDLE classified LIVE");
    const f = getMt5SeriesFreshness("EURUSD", "M5");
    eq(f.hasSeries, true, "CANDLE created an EURUSD|M5 series");
    eq(f.barCount, 1, "series has exactly the one merged bar");
    const r = await routeCandles("EURUSD", "M5", 100);
    eq(r.ok, true, "router ok after broker feed");
    eq(r.primaryProvider, "mt5_broker", "router serves mt5_broker first when fresh broker bars exist");
  }

  // ── 2. A SECOND accepted CANDLE merges (history preserved, not replaced) ──
  {
    const candle = {
      symbol: "EURUSD",
      timeframe: "M5",
      openTimeEpochMs: Date.UTC(2026, 5, 9, 12, 5, 0), // next bar
      open: 1.071, high: 1.073, low: 1.070, close: 1.072, volume: 110,
      isClosed: true as const,
    };
    const res = await ingest(envelope("CANDLE", candle, { sequence: 2, idem: `${RUN}-c2` }));
    eq(res.accepted, true, "second CANDLE accepted");
    eq(getMt5SeriesFreshness("EURUSD", "M5").barCount, 2, "second bar merged onto the series (history preserved)");
  }

  // ── 3. A sequence-DUPLICATE (accepted=false) is NOT fed ──
  // After bars seq 1 + 2, lastSequence=2. Re-send seq 2 with a FRESH idem key:
  // classifySequence → DUPLICATE, accepted=false, returned via the normal path
  // (no exception). The feed must be skipped because result.accepted is false.
  {
    const candle = {
      symbol: "EURUSD",
      timeframe: "M5",
      openTimeEpochMs: Date.UTC(2026, 5, 9, 12, 10, 0),
      open: 1.072, high: 1.074, low: 1.071, close: 1.073, volume: 120,
      isClosed: true as const,
    };
    const res = await ingest(envelope("CANDLE", candle, { sequence: 2, idem: `${RUN}-c3dup` }));
    eq(res.accepted, false, "sequence-duplicate not accepted");
    eq(res.outcome, "DUPLICATE", "sequence-duplicate → DUPLICATE");
    eq(getMt5SeriesFreshness("EURUSD", "M5").barCount, 2, "DUPLICATE did not feed a new bar");
  }

  // ── 4. STALE (>30s transport) is accepted/traced but NOT fed ──
  {
    const staleEpoch = Date.now() - 40_000; // 40s old → STALE
    const candle = {
      symbol: "GBPUSD",
      timeframe: "M5",
      openTimeEpochMs: Date.UTC(2026, 5, 9, 12, 0, 0),
      open: 1.27, high: 1.272, low: 1.269, close: 1.271, volume: 90,
      isClosed: true as const,
    };
    const res = await ingest(
      envelope("CANDLE", candle, { sequence: 1, idem: `${RUN}-stale`, eaCreatedAtEpochMs: staleEpoch, streamKey: "gbp" }),
    );
    eq(res.accepted, true, "STALE CANDLE still accepted + traced (honest record)");
    eq(res.freshnessVerdict, "STALE", "old transport → STALE");
    eq(getMt5SeriesFreshness("GBPUSD", "M5").hasSeries, false, "STALE CANDLE was NOT fed into the live store");
  }

  // ── 5. ACCEPTED + fresh TICK feeds a usable quote ──
  {
    const tick = { symbol: "EURUSD", bid: 1.0712, ask: 1.0714, brokerTimeEpochMs: Date.now() };
    const res = await ingest(envelope("TICK", tick, { sequence: 1, idem: `${RUN}-t1`, streamKey: "tick" }));
    eq(res.accepted, true, "fresh TICK accepted");
    const q = getMt5QuoteAvailability("EURUSD");
    eq(q.hasQuote, true, "TICK created a quote");
    eq(q.hasPrice, true, "TICK quote has a usable price");
  }

  // ── 6. EXACT idempotency-key replay → clean DUPLICATE, NOT re-fed (Task #416) ──
  // The EA retries a message verbatim (same idempotencyKey). The trace-row insert
  // hits the (user_id, idempotency_key) unique index → 23505 raised INSIDE the
  // tx, where drizzle 0.45.2 wraps it on e.cause.code. isUniqueViolation must
  // walk the cause chain so the catch returns DUPLICATE instead of re-throwing,
  // and the post-commit feed must be skipped (no silent re-stamp of the bar).
  {
    const candle = {
      symbol: "AUDUSD",
      timeframe: "M5",
      openTimeEpochMs: Date.UTC(2026, 5, 9, 12, 0, 0),
      open: 0.66, high: 0.662, low: 0.659, close: 0.661, volume: 80,
      isClosed: true as const,
    };
    const env = envelope("CANDLE", candle, { sequence: 1, idem: `${RUN}-replay`, streamKey: "aud" });
    const first = await ingest(env);
    eq(first.accepted, true, "first send of replay-candle accepted");
    eq(getMt5SeriesFreshness("AUDUSD", "M5").barCount, 1, "first send fed exactly one AUDUSD|M5 bar");

    // Re-send the EXACT same envelope (same idempotencyKey) — the wrapped 23505.
    const replay = await ingest(env);
    eq(replay.accepted, false, "exact idempotency replay not accepted (no thrown error)");
    eq(replay.outcome, "DUPLICATE", "exact idempotency replay → DUPLICATE");
    eq(replay.sequenceVerdict, "DUPLICATE", "exact idempotency replay verdict DUPLICATE");
    eq(getMt5SeriesFreshness("AUDUSD", "M5").barCount, 1, "exact idempotency replay did NOT re-feed/re-stamp the bar");
  }

  // ── Cleanup (fail-closed): remove only this run's synthetic rows ──
  await db.execute(sql`DELETE FROM bridge_v2_events WHERE user_id = ${USER_ID}`);
  await db.execute(sql`DELETE FROM bridge_v2_stream_state WHERE user_id = ${USER_ID}`);
  const leftEvents = await db.execute(sql`SELECT count(*)::int AS n FROM bridge_v2_events WHERE user_id = ${USER_ID}`);
  const leftState = await db.execute(sql`SELECT count(*)::int AS n FROM bridge_v2_stream_state WHERE user_id = ${USER_ID}`);
  const nEvents = Number((leftEvents.rows[0] as { n: number }).n);
  const nState = Number((leftState.rows[0] as { n: number }).n);
  eq(nEvents, 0, "cleanup removed synthetic bridge_v2_events rows");
  eq(nState, 0, "cleanup removed synthetic bridge_v2_stream_state rows");
}

main()
  .then(() => {
    console.log(`\nBridge v2 ingest→feed test: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
      process.exit(1);
    }
    console.log("All Bridge v2 ingest→feed assertions passed.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("Bridge v2 ingest→feed test crashed:", e);
    process.exit(1);
  });
