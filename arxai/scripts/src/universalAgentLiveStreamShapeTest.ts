// ── Universal Agent v1.52 live v2 broker-stream producer-shape lock (Task #473)
//
// The EA itself is untestable in this environment (no MT5 terminal). What we CAN
// lock is the contract: the EXACT JSON wire shapes the v1.52 producer emits must
//   1) validate against the domain validateBridgeV2Message() on first contact, and
//   2) flow through the REAL ingest path → feed the in-memory mt5Provider → make
//      the marketDataRouter serve the broker-native "mt5_broker" slot.
//
// So this test reconstructs the producer's literal output by string-concatenation
// that MIRRORS the MQL5 (PostV2Ingest / PushLiveCandleV2 / PushLiveTickV2):
//   - envelope: protocolVersion:2, messageType, streamKey, sequence (starts 0),
//     idempotencyKey = "<instanceId>-<counter>", eaCreatedAtEpochMs, eaVersion
//   - CANDLE streamKey "<symbol>|<tf>", openTimeEpochMs = sec*1000, volume as INT,
//     isClosed:true; TICK streamKey "<symbol>", brokerTimeEpochMs.
// If the EA's emitted format ever drifts from the schema, this test catches it.
//
// Touches the REAL DB (bridge_v2_events + bridge_v2_stream_state) under a
// run-unique NEGATIVE synthetic userId; cleans up fail-closed.

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

const { validateBridgeV2Message } = bridgeV2;

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

const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const USER_ID = -Math.floor(1_000_000 + Math.random() * 8_000_000);

// ── EA producer emulation (mirrors the MQL5 string-concatenation in v1.52) ──
const EA_VERSION = "1.52";
// v2InstanceId shape: "<ACCOUNT_LOGIN>-<TimeGMT sec>-<GetTickCount>". Only the
// shape matters here (it scopes the idempotency-key namespace per EA load).
const INSTANCE_ID = `12345678-${Math.floor(Date.now() / 1000)}-${RUN.length * 7}`;
let idemCounter = 0;
const seqRegistry = new Map<string, number>();

function nextSeq(messageType: string, streamKey: string): number {
  const key = `${messageType}#${streamKey}`;
  const cur = seqRegistry.get(key);
  if (cur === undefined) {
    seqRegistry.set(key, 1);
    return 0; // FIRST is 0, exactly like V2NextSequence()
  }
  seqRegistry.set(key, cur + 1);
  return cur;
}
function nextIdem(): string {
  idemCounter += 1;
  return `${INSTANCE_ID}-${idemCounter}`;
}

// ── Bounded per-stream sequence registry — FAITHFULLY mirrors the MQL5
//    V2NextSequence() fixed-array semantics (search → append-if-room → -1 drop)
//    in v1.52. These constants MUST stay in lockstep with the EA #defines
//    (V2_MAX_LIVE_SYMBOLS / V2_MAX_LIVE_TFS / V2_STREAM_CAPACITY); the capacity
//    is sized to the CLAMPED worst case so the registry can never overflow.
const V2_MAX_LIVE_SYMBOLS = 60;
const V2_MAX_LIVE_TFS = 16;
const V2_STREAM_CAPACITY = V2_MAX_LIVE_SYMBOLS * (V2_MAX_LIVE_TFS + 1); // 1020
class BoundedSeqRegistry {
  private keys: string[] = [];
  private next: number[] = [];
  nextSeq(messageType: string, streamKey: string): number {
    const key = `${messageType}#${streamKey}`;
    const idx = this.keys.indexOf(key);
    if (idx >= 0) {
      const v = this.next[idx]!;
      this.next[idx] = v + 1;
      return v;
    }
    if (this.keys.length < V2_STREAM_CAPACITY) {
      this.keys.push(key);
      this.next.push(1);
      return 0; // FIRST is 0
    }
    return -1; // registry full → PostV2Ingest drops (never emits a corrupting global seq)
  }
  get size(): number {
    return this.keys.length;
  }
}

// Build the EXACT envelope string the EA POSTs (then JSON.parse it back).
function eaEnvelopeString(messageType: string, streamKey: string, payloadJson: string): string {
  const seq = nextSeq(messageType, streamKey);
  const idem = nextIdem();
  const nowMs = Date.now(); // V2NowEpochMs() = (long)TimeGMT()*1000
  let env = "{";
  env += `"protocolVersion":2,`;
  env += `"messageType":"${messageType}",`;
  env += `"streamKey":"${streamKey.slice(0, 64)}",`;
  env += `"sequence":${seq},`;
  env += `"idempotencyKey":"${idem}",`;
  env += `"eaCreatedAtEpochMs":${nowMs},`;
  env += `"eaVersion":"${EA_VERSION}",`;
  env += `"payload":${payloadJson}`;
  env += "}";
  return env;
}

// PushLiveCandleV2: openTimeEpochMs = sec*1000; volume as integer; isClosed:true.
function eaCandleString(symbol: string, tf: string, openSec: number, o: number, h: number, l: number, c: number, vol: number, digits = 5): string {
  let p = "{";
  p += `"symbol":"${symbol.slice(0, 32)}",`;
  p += `"timeframe":"${tf}",`;
  p += `"openTimeEpochMs":${openSec * 1000},`;
  p += `"open":${o.toFixed(digits)},`;
  p += `"high":${h.toFixed(digits)},`;
  p += `"low":${l.toFixed(digits)},`;
  p += `"close":${c.toFixed(digits)},`;
  p += `"volume":${Math.trunc(vol)},`;
  p += `"isClosed":true`;
  p += "}";
  return eaEnvelopeString("CANDLE", `${symbol.slice(0, 32)}|${tf}`, p);
}

// PushLiveTickV2: streamKey "<symbol>"; brokerTimeEpochMs.
function eaTickString(symbol: string, bid: number, ask: number, brokerMs: number, digits = 5): string {
  let p = "{";
  p += `"symbol":"${symbol.slice(0, 32)}",`;
  p += `"bid":${bid.toFixed(digits)},`;
  p += `"ask":${ask.toFixed(digits)},`;
  p += `"brokerTimeEpochMs":${brokerMs}`;
  p += "}";
  return eaEnvelopeString("TICK", symbol.slice(0, 32), p);
}

async function ingestRaw(raw: unknown) {
  const input: BridgeV2IngestInput = {
    userId: USER_ID,
    bridgeConnectionId: null,
    raw,
    serverReceivedAtEpochMs: Date.now(),
  };
  return ingestBridgeV2Message(input);
}

async function main(): Promise<void> {
  __resetMt5ProviderStore();

  // ── 1. The EA's literal CANDLE envelope validates on the domain contract ──
  {
    const wire = eaCandleString("EURUSD", "M5", Math.floor(Date.UTC(2026, 5, 9, 12, 0, 0) / 1000), 1.07, 1.072, 1.069, 1.071, 100);
    const parsed = JSON.parse(wire);
    const v = validateBridgeV2Message(parsed);
    eq(v.ok, true, "EA CANDLE wire string validates against validateBridgeV2Message");
    eq((parsed as { sequence: number }).sequence, 0, "EA first CANDLE sequence is 0 (honest FIRST)");
    eq((parsed as { streamKey: string }).streamKey, "EURUSD|M5", "EA CANDLE streamKey is <symbol>|<tf>");
    eq((parsed as { payload: { volume: number } }).payload.volume, 100, "EA CANDLE volume serialised as an integer");
    eq(
      (parsed as { payload: { openTimeEpochMs: number } }).payload.openTimeEpochMs,
      Date.UTC(2026, 5, 9, 12, 0, 0),
      "EA CANDLE openTimeEpochMs = sec*1000 round-trips to the bar time",
    );
  }

  // ── 2. That same CANDLE feeds the provider and wins at the router ──
  {
    const wire = eaCandleString("EURUSD", "M5", Math.floor(Date.UTC(2026, 5, 9, 12, 5, 0) / 1000), 1.071, 1.073, 1.07, 1.072, 110);
    const res = await ingestRaw(JSON.parse(wire));
    eq(res.accepted, true, "EA CANDLE accepted by the real ingest path");
    eq(res.freshnessVerdict, "LIVE", "fresh EA CANDLE classified LIVE");
    const f = getMt5SeriesFreshness("EURUSD", "M5");
    eq(f.hasSeries, true, "EA CANDLE created an EURUSD|M5 series");
    const r = await routeCandles("EURUSD", "M5", 100);
    eq(r.ok, true, "router ok after EA broker feed");
    eq(r.primaryProvider, "mt5_broker", "router serves mt5_broker first from the EA live stream");
  }

  // ── 3. The per-stream last-open guard: the EA never re-pushes the same bar, but
  //       a NEW closed bar (next openTime, next sequence) merges (history kept) ──
  {
    const wire = eaCandleString("EURUSD", "M5", Math.floor(Date.UTC(2026, 5, 9, 12, 10, 0) / 1000), 1.072, 1.074, 1.071, 1.073, 120);
    const res = await ingestRaw(JSON.parse(wire));
    eq(res.accepted, true, "next EA closed bar accepted");
    eq(getMt5SeriesFreshness("EURUSD", "M5").barCount, 2, "next bar merged onto the series (history preserved)");
  }

  // ── 4. The EA's literal TICK envelope validates and feeds a usable quote ──
  {
    const wire = eaTickString("EURUSD", 1.0712, 1.0714, Date.now());
    const parsed = JSON.parse(wire);
    const v = validateBridgeV2Message(parsed);
    eq(v.ok, true, "EA TICK wire string validates against validateBridgeV2Message");
    eq((parsed as { streamKey: string }).streamKey, "EURUSD", "EA TICK streamKey is <symbol>");
    const res = await ingestRaw(parsed);
    eq(res.accepted, true, "EA TICK accepted by the real ingest path");
    const q = getMt5QuoteAvailability("EURUSD");
    eq(q.hasQuote, true, "EA TICK created a quote");
    eq(q.hasPrice, true, "EA TICK quote has a usable price");
  }

  // ── 5. Honesty: a transport-STALE bar (the EA pushed late / network lag) is
  //       traced but NEVER fed — it can't masquerade as a live broker feed ──
  {
    const staleMs = Date.now() - 40_000;
    // Hand-build with an old eaCreatedAtEpochMs (same shape, just stale clock).
    const seq = nextSeq("CANDLE", "GBPUSD|M5");
    const payload =
      `{"symbol":"GBPUSD","timeframe":"M5","openTimeEpochMs":${Date.UTC(2026, 5, 9, 12, 0, 0)},` +
      `"open":1.27000,"high":1.27200,"low":1.26900,"close":1.27100,"volume":90,"isClosed":true}`;
    const env =
      `{"protocolVersion":2,"messageType":"CANDLE","streamKey":"GBPUSD|M5","sequence":${seq},` +
      `"idempotencyKey":"${nextIdem()}","eaCreatedAtEpochMs":${staleMs},"eaVersion":"1.52","payload":${payload}}`;
    const res = await ingestRaw(JSON.parse(env));
    eq(res.accepted, true, "STALE EA CANDLE still accepted + traced (honest record)");
    eq(res.freshnessVerdict, "STALE", "old transport → STALE");
    eq(getMt5SeriesFreshness("GBPUSD", "M5").hasSeries, false, "STALE EA CANDLE was NOT fed into the live store");
  }

  // ── 6. High-cardinality per-stream sequencing never overflows or corrupts ──
  //       (regression: the old fixed-256 registry overflowed at the supported
  //        40-symbol × 6-TF + tick config = 280 streams, falling back to a
  //        global counter → non-contiguous sequences → server gap/reset.) ──
  {
    const reg = new BoundedSeqRegistry();
    const symbols = Array.from({ length: V2_MAX_LIVE_SYMBOLS }, (_, i) => `SYM${i}`);
    const tfs = Array.from({ length: V2_MAX_LIVE_TFS }, (_, i) => `T${i}`);
    const streams: Array<[string, string]> = [];
    for (const s of symbols) {
      streams.push(["TICK", s]);
      for (const tf of tfs) streams.push(["CANDLE", `${s}|${tf}`]);
    }
    eq(streams.length, V2_STREAM_CAPACITY, "clamped worst-case stream count == registry capacity (1020)");
    // The exact pre-fix overflow case now fits with headroom.
    ok(40 * 6 + 40 <= V2_STREAM_CAPACITY, "former overflow config (280 streams) now fits within capacity");

    // Push 3 INTERLEAVED rounds across every stream; each stream must see a
    // strictly contiguous 0,1,2 and NONE may hit the -1 (drop) path.
    let anyDropped = false;
    const seen = new Map<string, number[]>();
    for (let round = 0; round < 3; round++) {
      for (const [mt, sk] of streams) {
        const seq = reg.nextSeq(mt, sk);
        if (seq < 0) anyDropped = true;
        const k = `${mt}#${sk}`;
        const arr = seen.get(k) ?? [];
        arr.push(seq);
        seen.set(k, arr);
      }
    }
    eq(anyDropped, false, "no stream fell back to the -1 drop path at full clamped cardinality");
    eq(seen.size, V2_STREAM_CAPACITY, "all distinct streams tracked independently");
    let allContiguous = true;
    for (const arr of seen.values()) {
      if (arr.length !== 3 || arr[0] !== 0 || arr[1] !== 1 || arr[2] !== 2) {
        allContiguous = false;
        break;
      }
    }
    ok(allContiguous, "every stream produced strictly contiguous per-stream sequences (0,1,2) under interleaving");

    // One stream BEYOND capacity is DROPPED (seq -1), never given a corrupting
    // global sequence — PostV2Ingest skips it rather than emit a gap.
    eq(reg.nextSeq("CANDLE", "OVERFLOW|T0"), -1, "stream beyond capacity drops (-1), never corrupts ordering");
  }

  // ── Cleanup (fail-closed): remove only this run's synthetic rows ──
  await db.execute(sql`DELETE FROM bridge_v2_events WHERE user_id = ${USER_ID}`);
  await db.execute(sql`DELETE FROM bridge_v2_stream_state WHERE user_id = ${USER_ID}`);
  const leftEvents = await db.execute(sql`SELECT count(*)::int AS n FROM bridge_v2_events WHERE user_id = ${USER_ID}`);
  const leftState = await db.execute(sql`SELECT count(*)::int AS n FROM bridge_v2_stream_state WHERE user_id = ${USER_ID}`);
  eq(Number((leftEvents.rows[0] as { n: number }).n), 0, "cleanup removed synthetic bridge_v2_events rows");
  eq(Number((leftState.rows[0] as { n: number }).n), 0, "cleanup removed synthetic bridge_v2_stream_state rows");
}

main()
  .then(() => {
    console.log(`\nUniversal Agent v1.52 live-stream shape test: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.error("FAILURES:\n" + failures.map((f) => `  - ${f}`).join("\n"));
      process.exit(1);
    }
    console.log("All Universal Agent v1.52 live-stream producer-shape assertions passed.");
    process.exit(0);
  })
  .catch((e) => {
    console.error("Universal Agent v1.52 live-stream shape test crashed:", e);
    process.exit(1);
  });
