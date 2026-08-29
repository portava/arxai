// D2 COMPLETION — the byte-equality proof (backtest = shadow = live).
//
// The Black Box promise is that a decision can be REPLAYED: the features a
// backtest computes over recorded events, the features shadow mode stamps on a
// paper decision, and the features the live scanner attaches to a row are the
// SAME BYTES when fed the same window. Train/serve skew — the quiet killer —
// is any divergence between those three. This lane is the proof harness:
//
//   1. GOLDEN VECTOR — a recorded real event window (goldenWindow.fixture.ts)
//      is replayed through the BACKTEST path (chain-verified event replay),
//      the SHADOW path idiom (shadowMode.ts), and the LIVE path idiom
//      (marketScanner.ts). The three snapshots must be byte-identical, and
//      each must hash through the tamper-evident event chain to the SAME
//      recorded golden row hash. The three paths are handed the same CONTENT
//      in different REPRESENTATIONS (replayed vs shuffled vs reversed, with
//      and without volume) so representational noise can never masquerade as
//      — or hide — real divergence.
//   2. TAMPER — a flipped byte in the fixture fails chain-verify with a typed
//      CHECKSUM_MISMATCH at the tampered row, and shifts the feature bytes.
//      Divergence is the bug this harness exists to catch; if this lane ever
//      goes red on the golden anchors, the MATH or the CANONICALISER changed.
//   3. ONE IMPLEMENTATION — a repo-wide source pin that exactly one definition
//      of each feature primitive exists (computeFeatures, ewmaSigma,
//      synthSigma1min, candlePointInTimeReader, buildFeatureSnapshot,
//      FEATURE_SET_ID), and that the live + shadow call sites route through
//      the one adapter. A unit test cannot see a second implementation that
//      does not import it; this scan can.
//   4. REPLAY-CLOCK DISCIPLINE — the feature/backtest path reads NO wall
//      clock: a source pin (no Date.now / new Date() / performance.now /
//      Math.random / hrtime tokens in the path sources) plus an injected-clock
//      property (the whole three-path computation runs, byte-identical, under
//      a POISONED global clock that throws on any wall-clock read).
//
// Offline, no DB, no network. Run:
//   node --import tsx --test --test-force-exit \
//     src/lib/features/__qa__/blackboxParity.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeRowHash,
  verifyChainRows,
  stableStringify,
  type ChainRow,
} from "@workspace/features";
import {
  buildFeatureSnapshot,
  latestCloseIso,
  type FeatureCandle,
  type FeatureSnapshot,
} from "../featureSnapshot.js";
import {
  GOLDEN_SYMBOL,
  GOLDEN_ASOF_ISO,
  GOLDEN_BAR_COUNT,
  GOLDEN_HEAD_HASH,
  GOLDEN_SNAPSHOT_DATA_HASH,
  GOLDEN_SNAPSHOT_ROW_HASH,
  goldenWindowEvents,
  type RecordedWindowEvent,
} from "./goldenWindow.fixture.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../../..", import.meta.url));

// ── The three path CODES ────────────────────────────────────────────────────
//
// Backtest, shadow and live share ONE pure engine by construction; what can
// still diverge is the path-side composition around it (which candles, which
// asOf anchor, what happens to refusals). Each function below reproduces one
// call site's composition VERBATIM — and the source pins further down prove
// the real call sites still look like this, so the idioms cannot silently
// drift away from what this harness exercises.

/**
 * BACKTEST path: replay a recorded `event_log` window. The chain is verified
 * BEFORE any feature math — a backtest over tampered history is not evidence
 * — then the candle series is reconstructed from event fields (oldest-first,
 * closes only matter; volume deliberately dropped: it is not a feature input
 * and reconstruction must not need it) and the ONE engine runs with the
 * data-anchored asOf.
 */
function backtestPathSnapshot(rows: readonly ChainRow[], symbol: string): FeatureSnapshot {
  const v = verifyChainRows(rows);
  if (!v.valid) {
    throw new Error(
      `backtest replay refused: chain broken at ${v.brokenEventId} (${v.reason})`,
    );
  }
  const candles: FeatureCandle[] = rows.map((r) => ({
    time: String(r.fields.time),
    open: Number(r.fields.open),
    high: Number(r.fields.high),
    low: Number(r.fields.low),
    close: Number(r.fields.close),
  }));
  const asOf = latestCloseIso(candles);
  if (asOf === null) throw new Error("backtest replay refused: no honest asOf anchor");
  return buildFeatureSnapshot(symbol, candles, asOf);
}

/** LIVE path idiom — marketScanner.ts, verbatim shape (routed window). */
function livePathSnapshot(
  routed: { regimeCandles: FeatureCandle[] | null } | undefined,
  sym: string,
): FeatureSnapshot | undefined {
  let featureSnapshot: FeatureSnapshot | undefined;
  const featureCandles = routed?.regimeCandles ?? [];
  const featureAsOf = latestCloseIso(featureCandles);
  if (featureAsOf !== null) {
    featureSnapshot = buildFeatureSnapshot(sym, featureCandles, featureAsOf);
  }
  return featureSnapshot;
}

/** SHADOW path idiom — shadowMode.ts, verbatim shape (strategy-loop window). */
function shadowPathSnapshot(
  symbol: string,
  candles: readonly FeatureCandle[],
): FeatureSnapshot | undefined {
  let featureSnapshot: FeatureSnapshot | undefined;
  const featureAsOf = latestCloseIso(candles);
  if (featureAsOf !== null) {
    featureSnapshot = buildFeatureSnapshot(symbol, [...candles], featureAsOf);
  }
  return featureSnapshot;
}

// ── Representations of the SAME recorded content ────────────────────────────

function recordedChain(events: readonly RecordedWindowEvent[]): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev: string | null = null;
  for (const e of events) {
    const rowHash = computeRowHash(e.fields, prev);
    rows.push({ eventId: e.eventId, fields: e.fields, prevHash: prev, rowHash });
    prev = rowHash;
  }
  return rows;
}

function toCandle(e: RecordedWindowEvent, withVolume: boolean): FeatureCandle {
  const c: FeatureCandle = {
    time: e.fields.time,
    open: e.fields.open,
    high: e.fields.high,
    low: e.fields.low,
    close: e.fields.close,
  };
  if (withVolume) c.volume = e.fields.volume;
  return c;
}

/** Deterministic Fisher–Yates via a fixed LCG — no Math.random anywhere here. */
function deterministicShuffle<T>(xs: readonly T[]): T[] {
  const out = [...xs];
  let s = 0xbadc0de >>> 0;
  const rand = () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Run all three paths over the recorded window; used pristine AND poisoned. */
function computeAllThreePaths(): {
  backtest: FeatureSnapshot;
  live: FeatureSnapshot | undefined;
  shadow: FeatureSnapshot | undefined;
  headHash: string;
} {
  const events = goldenWindowEvents();
  const rows = recordedChain(events);
  const headHash = rows[rows.length - 1]!.rowHash;
  // Backtest: chain-verified replay, sorted oldest-first, volume dropped.
  const backtest = backtestPathSnapshot(rows, GOLDEN_SYMBOL);
  // Live: the routed window as the scanner holds it — shuffled arrival order,
  // volume present. Same content, different representation.
  const live = livePathSnapshot(
    { regimeCandles: deterministicShuffle(events.map((e) => toCandle(e, true))) },
    GOLDEN_SYMBOL,
  );
  // Shadow: the strategy loop's series — newest-first, volume present.
  const shadow = shadowPathSnapshot(
    GOLDEN_SYMBOL,
    events.map((e) => toCandle(e, true)).reverse(),
  );
  return { backtest, live, shadow, headHash };
}

function snapshotChainRow(snap: FeatureSnapshot, prevHash: string): ChainRow {
  const fields = { kind: "FEATURE_SNAPSHOT", snapshot: snap };
  return {
    eventId: "feat-golden",
    fields,
    prevHash,
    rowHash: computeRowHash(fields, prevHash),
  };
}

// ── 1. Golden vector: byte equality across the three paths ──────────────────

test("recorded window chain verifies and matches the recorded head hash", () => {
  const rows = recordedChain(goldenWindowEvents());
  assert.equal(rows.length, GOLDEN_BAR_COUNT);
  const v = verifyChainRows(rows);
  assert.equal(v.valid, true);
  assert.equal(v.checked, GOLDEN_BAR_COUNT);
  assert.equal(rows[rows.length - 1]!.rowHash, GOLDEN_HEAD_HASH);
});

test("backtest, shadow and live path code produce BYTE-IDENTICAL snapshots", () => {
  const { backtest, live, shadow, headHash } = computeAllThreePaths();

  assert.ok(live !== undefined && shadow !== undefined, "live/shadow paths produced a snapshot");
  assert.equal(backtest.available, true, "the recorded window yields a vector, not a refusal");

  // Byte equality, twice over: the exact serialisation each path would
  // persist, and the canonical form the chain hashes.
  assert.equal(JSON.stringify(backtest), JSON.stringify(live));
  assert.equal(JSON.stringify(backtest), JSON.stringify(shadow));
  assert.equal(stableStringify(backtest), stableStringify(live));
  assert.equal(stableStringify(backtest), stableStringify(shadow));

  // The engine's own provenance hash matches the recorded golden — if this
  // moves, the feature MATH (or the canonicaliser) changed, and FEATURE_SET_ID
  // must be bumped deliberately, never silently.
  assert.equal(backtest.available && backtest.features.dataSnapshotHash, GOLDEN_SNAPSHOT_DATA_HASH);
  assert.equal(backtest.available && backtest.features.asOfIso, GOLDEN_ASOF_ISO);

  // Hash each path's snapshot through the event chain at the SAME position:
  // identical row hashes ⇒ identical canonical bytes ⇒ identical evidence.
  assert.equal(headHash, GOLDEN_HEAD_HASH);
  const rB = snapshotChainRow(backtest, headHash);
  const rL = snapshotChainRow(live!, headHash);
  const rS = snapshotChainRow(shadow!, headHash);
  assert.equal(rB.rowHash, rL.rowHash);
  assert.equal(rB.rowHash, rS.rowHash);
  assert.equal(rB.rowHash, GOLDEN_SNAPSHOT_ROW_HASH);

  // And the extended chain (window + snapshot) verifies end to end.
  const v = verifyChainRows([...recordedChain(goldenWindowEvents()), rB]);
  assert.equal(v.valid, true);
});

test("synthetic closed form is byte-identical across paths and asOf-invariant", () => {
  const V75 = "Volatility 75 Index";
  const events = goldenWindowEvents();
  const rows = recordedChain(events);
  const backtest = backtestPathSnapshot(rows, V75);
  const live = livePathSnapshot(
    { regimeCandles: deterministicShuffle(events.map((e) => toCandle(e, true))) },
    V75,
  );
  const shadow = shadowPathSnapshot(V75, events.map((e) => toCandle(e, true)).reverse());
  assert.equal(JSON.stringify(backtest), JSON.stringify(live));
  assert.equal(JSON.stringify(backtest), JSON.stringify(shadow));
  // Cross-pin with scripts/src/blackBoxFeaturesTest.ts: the V75 provenance
  // hash is a shared golden anchor, independently derived there.
  assert.equal(
    backtest.available && backtest.features.dataSnapshotHash,
    "25ac20b2783fae5827c5aeb31f6d3d51e7750b68cce58d43d820ee890562e1d1",
  );
});

// ── 2. Tamper: a flipped byte in the fixture must fail chain-verify ─────────

test("a flipped byte in the fixture fails chain-verify as CHECKSUM_MISMATCH", () => {
  const rows = recordedChain(goldenWindowEvents());
  const i = 30; // inside the σ estimation window (last 60 of 61 bars)
  const tampered = rows.map((r) => ({ ...r, fields: { ...r.fields } }));
  // One byte of one close: 1.xxxxx → +0.00001 (the stored rowHash is KEPT —
  // that recorded hash no longer describes the tampered bytes).
  tampered[i]!.fields.close = Number(tampered[i]!.fields.close) + 0.00001;

  const v = verifyChainRows(tampered);
  assert.equal(v.valid, false);
  assert.equal(v.reason, "CHECKSUM_MISMATCH");
  assert.equal(v.firstBreakIndex, i);
  assert.equal(v.brokenEventId, rows[i]!.eventId);

  // A backtest replay REFUSES tampered history outright.
  assert.throws(() => backtestPathSnapshot(tampered, GOLDEN_SYMBOL), /chain broken/);
});

test("the flipped byte also shifts the feature bytes (no silent absorption)", () => {
  const events = goldenWindowEvents();
  events[30]!.fields.close = events[30]!.fields.close + 0.00001;
  // Re-chained honestly (an attacker who can rewrite the WHOLE chain), the
  // window is internally consistent — but the features it yields are now
  // different bytes, so the recorded golden anchors still catch it.
  const rows = recordedChain(events);
  assert.notEqual(rows[rows.length - 1]!.rowHash, GOLDEN_HEAD_HASH);
  const snap = backtestPathSnapshot(rows, GOLDEN_SYMBOL);
  assert.ok(snap.available);
  assert.notEqual(snap.features.dataSnapshotHash, GOLDEN_SNAPSHOT_DATA_HASH);
});

test("a flipped byte in the appended snapshot row is caught too", () => {
  const rows = recordedChain(goldenWindowEvents());
  const head = rows[rows.length - 1]!.rowHash;
  const snap = backtestPathSnapshot(rows, GOLDEN_SYMBOL);
  const row = snapshotChainRow(snap, head);
  const forged: ChainRow = {
    ...row,
    fields: {
      ...row.fields,
      snapshot: JSON.parse(
        JSON.stringify(row.fields.snapshot).replace(GOLDEN_SNAPSHOT_DATA_HASH.slice(0, 8),
          "00000000"),
      ),
    },
  };
  const v = verifyChainRows([...rows, forged]);
  assert.equal(v.valid, false);
  assert.equal(v.reason, "CHECKSUM_MISMATCH");
  assert.equal(v.brokenEventId, "feat-golden");
});

// ── 3. One implementation (repo-wide source pin) ────────────────────────────

const SCAN_ROOTS = [
  "lib",
  "artifacts/api-server/src",
  "artifacts/trading-dashboard/src",
  "scripts/src",
];

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__qa__") {
        continue;
      }
      yield* walkTs(p);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      yield p;
    }
  }
}

test("exactly ONE definition of each feature primitive exists repo-wide", () => {
  // A second implementation of the same feature family is train/serve skew
  // waiting to happen — and a unit test cannot see an implementation that
  // does not import the first one. This scan can. Both `function name(` and
  // `name = (` (arrow/rebinding) count as definitions.
  const primitives: Array<{ name: string; expectedIn: string }> = [
    { name: "computeFeatures", expectedIn: join("lib", "features", "src", "index.ts") },
    { name: "ewmaSigma", expectedIn: join("artifacts", "api-server", "src", "lib", "features", "featureSnapshot.ts") },
    { name: "synthSigma1min", expectedIn: join("lib", "markets", "src", "expectedMove.ts") },
    { name: "candlePointInTimeReader", expectedIn: join("artifacts", "api-server", "src", "lib", "features", "featureSnapshot.ts") },
    { name: "buildFeatureSnapshot", expectedIn: join("artifacts", "api-server", "src", "lib", "features", "featureSnapshot.ts") },
  ];
  const defs = new Map<string, string[]>(primitives.map((p) => [p.name, []]));

  for (const root of SCAN_ROOTS) {
    for (const file of walkTs(join(REPO_ROOT, root))) {
      const src = readFileSync(file, "utf8");
      for (const p of primitives) {
        const re = new RegExp(
          `\\bfunction ${p.name}\\s*\\(|\\b${p.name}\\s*=\\s*(?:async\\s*)?\\(`,
        );
        if (re.test(src)) defs.get(p.name)!.push(file);
      }
    }
  }

  for (const p of primitives) {
    const found = defs.get(p.name)!;
    assert.equal(
      found.length,
      1,
      `${p.name} must have exactly one definition; found ${found.length}: ${found.join(", ")}`,
    );
    assert.ok(
      found[0]!.endsWith(p.expectedIn),
      `${p.name} defined in ${found[0]} — expected ${p.expectedIn}`,
    );
  }
});

test("FEATURE_SET_ID is assigned in exactly one place (lib/features)", () => {
  const assigned: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of walkTs(join(REPO_ROOT, root))) {
      if (/\bFEATURE_SET_ID\s*=[^=]/.test(readFileSync(file, "utf8"))) assigned.push(file);
    }
  }
  assert.equal(assigned.length, 1, `FEATURE_SET_ID assigned in: ${assigned.join(", ")}`);
  assert.ok(assigned[0]!.endsWith(join("lib", "features", "src", "index.ts")));
});

test("live and shadow call sites route through the ONE adapter (source pin)", () => {
  const scanner = readFileSync(
    join(REPO_ROOT, "artifacts/api-server/src/lib/marketScanner.ts"),
    "utf8",
  );
  const shadow = readFileSync(
    join(REPO_ROOT, "artifacts/api-server/src/lib/shadowMode.ts"),
    "utf8",
  );
  // Both import from the one adapter…
  assert.ok(scanner.includes('from "./features/featureSnapshot.js"'));
  assert.ok(shadow.includes('from "./features/featureSnapshot.js"'));
  // …and their compositions are the exact idioms this harness replays.
  assert.ok(scanner.includes("buildFeatureSnapshot(sym, featureCandles, featureAsOf)"));
  assert.ok(scanner.includes("latestCloseIso(featureCandles)"));
  assert.ok(shadow.includes("buildFeatureSnapshot(symbol, candles, featureAsOf)"));
  assert.ok(shadow.includes("latestCloseIso(candles)"));
  // Neither computes features around the seam: no direct engine import.
  assert.ok(!scanner.includes('from "@workspace/features"'));
  assert.ok(!shadow.includes('from "@workspace/features"'));
});

// ── 4. Replay-clock discipline ──────────────────────────────────────────────

/** Every source file on the feature/backtest compute path. */
const CLOCK_CLEAN_FILES = [
  "lib/features/src/index.ts",
  "lib/features/src/eventChain.ts",
  "lib/markets/src/expectedMove.ts",
  "artifacts/api-server/src/lib/features/featureSnapshot.ts",
  "artifacts/api-server/src/lib/backtest/backtestChartSeries.ts",
  "artifacts/api-server/src/lib/backtest/backtestDataReliability.ts",
];

const WALL_CLOCK_TOKENS = [
  "Date.now",
  "new Date()",
  "performance.now",
  "Math.random",
  "hrtime",
  "setTimeout",
  "setInterval",
];

test("no wall-clock or randomness tokens in the feature/backtest path (source pin)", () => {
  for (const rel of CLOCK_CLEAN_FILES) {
    const src = readFileSync(join(REPO_ROOT, rel), "utf8");
    for (const token of WALL_CLOCK_TOKENS) {
      assert.ok(
        !src.includes(token),
        `${rel} contains "${token}" — the replay path must be a pure function of its inputs`,
      );
    }
  }
});

test("the whole three-path computation survives a POISONED clock, byte-identical", () => {
  // If ANY code on the path reads the wall clock, this run throws; if any
  // code depends on it more subtly, the bytes differ from the pristine run.
  const pristine = computeAllThreePaths();

  const RealDate = Date;
  const realMathRandom = Math.random;
  const realPerfNow = performance.now;
  const PoisonedDate = class extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        throw new Error("BLACKBOX_PARITY: wall-clock read (new Date())");
      }
      super(...(args as [number]));
    }
    static override now(): number {
      throw new Error("BLACKBOX_PARITY: wall-clock read (Date.now())");
    }
  } as DateConstructor;

  let poisoned: ReturnType<typeof computeAllThreePaths>;
  try {
    globalThis.Date = PoisonedDate;
    Math.random = () => {
      throw new Error("BLACKBOX_PARITY: nondeterminism (Math.random())");
    };
    performance.now = () => {
      throw new Error("BLACKBOX_PARITY: wall-clock read (performance.now())");
    };
    poisoned = computeAllThreePaths();
  } finally {
    globalThis.Date = RealDate;
    Math.random = realMathRandom;
    performance.now = realPerfNow;
  }

  assert.equal(JSON.stringify(poisoned.backtest), JSON.stringify(pristine.backtest));
  assert.equal(JSON.stringify(poisoned.live), JSON.stringify(pristine.live));
  assert.equal(JSON.stringify(poisoned.shadow), JSON.stringify(pristine.shadow));
  assert.equal(poisoned.headHash, GOLDEN_HEAD_HASH);
  // And the poisoned run still lands on the recorded golden anchors.
  assert.equal(
    poisoned.backtest.available && poisoned.backtest.features.dataSnapshotHash,
    GOLDEN_SNAPSHOT_DATA_HASH,
  );
});
