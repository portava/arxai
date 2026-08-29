// ═══════════════════════════════════════════════════════════════════════════
// transportClockBaseline.test.ts — R4: skew-corrected ingest transport grade.
//
// THE DEFECT: ingest graded freshness on raw serverReceivedAt - eaCreatedAt
// with a 30s STALE cutoff, so an EA host clock >30s BEHIND the server graded
// EVERY message STALE forever — zero market-data feeds, zero forming folds, a
// permanently frozen broker chart off a healthy feed. (And the Math.max(0,..)
// clamp FORGAVE a clock running ahead, hiding genuinely late replays.)
//
// Covers:
//   [A] The estimator: warm-up fails closed (raw verdict), the running-min
//       baseline converges under jittery latency, a genuinely late replay is
//       still dropped, a clock-AHEAD EA's late replay is now caught, RESET
//       re-anchors (EA restart with a different clock), idle expiry, and
//       per-connection isolation.
//   [B] The ingest feed seam (feedAcceptedBridgeMarketData — everything below
//       the DB transaction, driven exactly as ingestBridgeV2Message does):
//       a clock-behind EA's ticks reach the quote store + forming composer
//       once the baseline converges, and a genuine 35s-late tick on a healthy
//       connection is still dropped.
//
// HONESTY: the correction changes only the in-memory FEED decision; the trace
// row keeps the raw measurement (pinned by inspecting the ingest source).
//
// SAFETY: pure/in-memory. The dummy unroutable DATABASE_URL only satisfies
// the @workspace/db import — no connection is ever attempted (the feed seam
// sits POST-transaction and touches no table).
//
// Run: pnpm --filter @workspace/api-server run test:bridge-transport-baseline

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  gradeCorrectedTransportFreshness,
  TRANSPORT_BASELINE_MIN_SAMPLES,
  TRANSPORT_BASELINE_IDLE_RESET_MS,
  __resetTransportClockBaselineForTests,
} from "../transportClockBaseline.js";
import { feedAcceptedBridgeMarketData } from "../ingest.js";
import {
  getFormingBar,
  __resetFormingBarStore,
} from "../../data/chart/formingBarComposer.js";
import {
  getMt5QuoteAvailability,
  __resetMt5ProviderStore,
} from "../../data/providers/mt5Provider.js";

const USER = 7;
const CONN = 42;

function grade(rawMs: number, verdict: string = "IN_ORDER", nowMs?: number) {
  return gradeCorrectedTransportFreshness({
    userId: USER,
    bridgeConnectionId: CONN,
    rawTransportDiffMs: rawMs,
    sequenceVerdict: verdict,
    ...(nowMs != null ? { nowMs } : {}),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// [A] Estimator
// ═══════════════════════════════════════════════════════════════════════════

test("[A1] clock-behind EA: warm-up grades raw STALE, then corrected LIVE", () => {
  __resetTransportClockBaselineForTests();
  // EA host clock 60s behind the server; real transport latency jitters 300-900ms.
  const jitter = [500, 300, 900, 700, 400, 600, 350];
  const verdicts = jitter.map((j) => grade(60_000 + j));
  // Warm-up (first MIN_SAMPLES-1 messages after the seed count toward it):
  // every pre-warm-up verdict is the RAW one — STALE, exactly today's behavior.
  for (let i = 0; i < TRANSPORT_BASELINE_MIN_SAMPLES - 1; i++) {
    assert.equal(verdicts[i], "STALE", `message ${i + 1} still fails closed during warm-up`);
  }
  // Converged: effective latency = raw - min(baseline) ≈ jitter delta << 5s.
  for (let i = TRANSPORT_BASELINE_MIN_SAMPLES - 1; i < verdicts.length; i++) {
    assert.equal(verdicts[i], "LIVE", `message ${i + 1} grades LIVE on the corrected latency`);
  }
});

test("[A2] genuine 35s-late replay on a healthy connection is still dropped", () => {
  __resetTransportClockBaselineForTests();
  // Healthy connection: clock aligned, ~100-300ms transport.
  for (const j of [200, 100, 300, 150, 250, 180]) {
    assert.equal(grade(j), "LIVE");
  }
  // A message that genuinely arrived 35s after its (correct) eaCreatedAt.
  assert.equal(grade(35_000), "STALE", "true transport staleness must never be forgiven");
});

test("[A3] clock-AHEAD EA: a late replay no longer hides behind the zero clamp", () => {
  __resetTransportClockBaselineForTests();
  // EA clock 20s ahead → raw diff ≈ -20s + latency (negative).
  for (const j of [300, 150, 400, 250, 200, 350]) {
    assert.equal(grade(-20_000 + j), "LIVE");
  }
  // Replay arriving 40s late: raw = -20s + 40s = +20s → the OLD raw grade
  // (Math.max(0, 20s)) would say merely DELAYED; the corrected grade sees 40s.
  assert.equal(grade(-20_000 + 40_000), "STALE", "corrected grade catches the clock-ahead replay");
});

test("[A4] RESET re-anchors: an EA restart with a different clock adapts", () => {
  __resetTransportClockBaselineForTests();
  // First life: clock 60s behind, converged.
  for (const j of [400, 300, 500, 350, 450, 380]) grade(60_000 + j);
  assert.equal(grade(60_000 + 420), "LIVE");
  // Restart: sequence RESET, clock now aligned. The message itself re-seeds.
  assert.equal(grade(250, "RESET"), "LIVE", "raw verdict of the re-seeding message");
  // Warm-up again, then converged on the NEW clock.
  const verdicts = [300, 200, 350, 280, 320].map((j) => grade(j));
  assert.equal(verdicts[verdicts.length - 1], "LIVE");
  // Old-clock-shaped message after the reset is honestly late now.
  assert.equal(grade(60_000), "STALE", "the stale-clock baseline did not survive the reset");
});

test("[A5] idle expiry: a long-silent connection re-anchors from scratch", () => {
  __resetTransportClockBaselineForTests();
  const t0 = 1_000_000;
  for (const [i, j] of [400, 300, 500, 350, 450, 380].entries()) {
    grade(60_000 + j, "IN_ORDER", t0 + i * 1_000);
  }
  assert.equal(grade(60_000 + 420, "IN_ORDER", t0 + 7_000), "LIVE", "converged before the gap");
  // Silence past the idle window → the next message is a fresh seed (raw grade).
  const later = t0 + 7_000 + TRANSPORT_BASELINE_IDLE_RESET_MS + 1_000;
  assert.equal(grade(60_000 + 400, "IN_ORDER", later), "STALE", "expired baseline fails closed again");
});

test("[A6] baselines are per-connection: one skewed EA never loosens another", () => {
  __resetTransportClockBaselineForTests();
  // Connection A converges on a 60s-behind clock.
  for (const j of [400, 300, 500, 350, 450, 380]) grade(60_000 + j);
  assert.equal(grade(60_000 + 420), "LIVE");
  // Connection B (different bridgeConnectionId) with a genuinely 60s-late
  // message must NOT inherit A's baseline.
  const b = gradeCorrectedTransportFreshness({
    userId: USER,
    bridgeConnectionId: CONN + 1,
    rawTransportDiffMs: 60_000,
    sequenceVerdict: "FIRST",
  });
  assert.equal(b, "STALE", "a fresh connection starts from the raw fail-closed grade");
});

// ═══════════════════════════════════════════════════════════════════════════
// [B] Ingest feed seam — everything below the DB transaction
// ═══════════════════════════════════════════════════════════════════════════

function feedTick(opts: {
  bid: number;
  rawDiffMs: number;
  sequenceVerdict?: string;
  connId?: number;
}): void {
  feedAcceptedBridgeMarketData({
    userId: USER,
    bridgeConnectionId: opts.connId ?? CONN,
    messageType: "TICK",
    payload: {
      symbol: "EURUSD",
      bid: opts.bid,
      ask: opts.bid + 0.0002,
      // Broker SERVER time is fresh — only the EA HOST clock is skewed.
      brokerTimeEpochMs: Date.now(),
    },
    rawTransportDiffMs: opts.rawDiffMs,
    sequenceVerdict: opts.sequenceVerdict ?? "IN_ORDER",
  });
}

test("[B1] clock-behind EA folds again once the baseline converges", () => {
  __resetTransportClockBaselineForTests();
  __resetFormingBarStore();
  __resetMt5ProviderStore();

  // Warm-up: raw-STALE messages are dropped (no fabricated freshness).
  for (let i = 0; i < TRANSPORT_BASELINE_MIN_SAMPLES - 1; i++) {
    feedTick({ bid: 1.1 + i * 0.0001, rawDiffMs: 60_000 + 300 + i * 50 });
  }
  assert.equal(getMt5QuoteAvailability("EURUSD").hasQuote, false, "warm-up ticks stay dropped");
  assert.equal(getFormingBar("EURUSD", "M1", Date.now()), null, "no forming fold during warm-up");

  // Converged: the same skewed connection's ticks now reach both stores.
  feedTick({ bid: 1.2345, rawDiffMs: 60_000 + 400 });
  const q = getMt5QuoteAvailability("EURUSD");
  assert.equal(q.hasQuote, true, "quote store updated on the corrected verdict");
  assert.equal(q.hasPrice, true);
  const bar = getFormingBar("EURUSD", "M1", Date.now());
  assert.ok(bar, "forming tick folded on the corrected verdict");
  assert.equal(bar.close, 1.2345);
  assert.equal(bar.provider, "mt5_broker", "ingest folds carry the broker provider identity");
});

test("[B2] genuine 35s transport latency still drops (store + composer)", () => {
  __resetTransportClockBaselineForTests();
  __resetFormingBarStore();
  __resetMt5ProviderStore();

  // Healthy warm-up: aligned clock, fast transport — every tick feeds.
  for (const [i, j] of [200, 150, 300, 250, 180, 220].entries()) {
    feedTick({ bid: 1.3 + i * 0.0001, rawDiffMs: j });
  }
  const before = getFormingBar("EURUSD", "M1", Date.now());
  assert.ok(before, "healthy ticks fold");
  const lastClose = before.close;

  // A genuinely 35s-late tick must not touch either store.
  feedTick({ bid: 9.9999, rawDiffMs: 35_000 });
  const after = getFormingBar("EURUSD", "M1", Date.now());
  assert.ok(after);
  assert.equal(after.close, lastClose, "the late tick never reached the composer");
});

// ═══════════════════════════════════════════════════════════════════════════
// [C] Audit honesty — the trace row keeps the RAW measurement
// ═══════════════════════════════════════════════════════════════════════════

test("[C1] ingest still records raw transportLatencyMs/freshnessVerdict in the trace row", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(HERE, "../ingest.ts"), "utf8");
  // The row is built from the raw clamp of the signed diff, never the
  // corrected verdict: telemetry records what was measured.
  assert.ok(
    /const transportLatencyMs = Math\.max\(0, rawTransportDiffMs\);/.test(src),
    "raw latency measurement must remain the trace-row fact",
  );
  assert.ok(
    /transportLatencyMs,\s*\n\s*freshnessVerdict,/.test(src),
    "the trace row must carry the raw latency + raw verdict",
  );
  assert.ok(
    /feedAcceptedBridgeMarketData\(\{/.test(src),
    "the feed decision must flow through the skew-corrected grade",
  );
});
