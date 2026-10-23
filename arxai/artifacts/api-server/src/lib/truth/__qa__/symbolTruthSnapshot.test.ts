// Task #512 — One Truth, One Brain acceptance tests.
// Run via:
//   node --import tsx --test src/lib/truth/__qa__/symbolTruthSnapshot.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:symbol-truth`)
//
// These lock the seven acceptance criteria for the single per-symbol Truth
// Snapshot, plus a read-side-only "no heat write" deps spy:
//
//   1. stale-levels guard      — saved geometry far from price is WITHHELD
//   2. one freshness           — a single data.state drives every surface
//   3. one news state          — providerConnected + a single disclaimer
//   4. evidence honesty        — only present+aligned components are cited
//   5. invalidation geometry   — side derived purely from level geometry
//   6. strength/label parity   — one clean label per component, deterministic
//   7. no internal strings     — no UPPER_SNAKE enum tokens reach user copy
//   (+) no-heat-write spy       — timing is computed with persistSnapshot:false
//
// The brain is exercised through its injectable SOURCE deps so the tests are
// deterministic — no DB, no network, no clock dependence (generatedAt aside).
// The pure composer is exercised directly where the rule lives in the domain.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSymbolTruthSnapshot,
  type SymbolTruthSnapshot,
  type TruthSnapshotDeps,
} from "../symbolTruthSnapshot.js";
import { composeVerdict, evaluateLevelStaleness } from "@workspace/domain/truth";

// ── SOURCE return types (taken from the brain's own dep contract) ─────────────

type ChartResult = Awaited<ReturnType<TruthSnapshotDeps["getChartCandlesFn"]>>;
type NewsResult = Awaited<ReturnType<TruthSnapshotDeps["buildNewsFn"]>>;
type ScannerResult = Awaited<ReturnType<TruthSnapshotDeps["buildScannerFn"]>>;
type ScalpResult = Awaited<ReturnType<TruthSnapshotDeps["evaluateScalpFn"]>>;
type TimingResult = Awaited<ReturnType<TruthSnapshotDeps["computeTimingFn"]>>;

// ── Deterministic SOURCE stubs (only the fields the brain reads matter) ───────

function candles(closes: number[], spread = 0.001): unknown[] {
  return closes.map((c) => ({
    open: c,
    high: c + spread,
    low: c - spread,
    close: c,
  }));
}

function chartStub(opts: {
  state?: "LIVE_CONFIRMED" | "SYNCING" | "STALE" | "UNAVAILABLE";
  price?: number;
  spread?: number;
  bars?: number;
} = {}): ChartResult {
  const price = opts.price ?? 1.1;
  const state = opts.state ?? "LIVE_CONFIRMED";
  // Default a healthy stub to ≥ MIN_SUFFICIENT_CLOSED_BARS so it is "sufficient"
  // for a directional read; tests that probe the readability floor pass `bars`.
  const bars = opts.bars ?? 6;
  const isLive = state === "LIVE_CONFIRMED";
  const stale = state === "STALE";
  const quality =
    state === "UNAVAILABLE"
      ? "unavailable"
      : state === "STALE"
        ? "stale"
        : "clean";
  const feedStatus = {
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    source: "mt5_broker",
    isLive,
    stale,
    quality,
    lastCandleTime: "2026-06-07T00:00:00.000Z",
    lastTickTime: "2026-06-07T00:00:05.000Z",
  };
  const closes = Array.from(
    { length: Math.max(0, bars) },
    (_, i) => price - (bars - 1 - i) * 0.001,
  );
  return {
    candles: candles(closes, opts.spread),
    feedStatus,
    source: "mt5_broker",
    displaySymbol: "EUR/USD",
  } as unknown as ChartResult;
}

function newsStub(opts: {
  connected?: boolean;
  events?: { id: string; severity?: string; affects?: boolean }[];
  topSeverity?: string | null;
  highImpact?: boolean;
} = {}): NewsResult {
  const connected = opts.connected ?? true;
  return {
    radar: {
      symbol: "EURUSD",
      provider: { connected, name: "test-calendar", note: "" },
      events: (opts.events ?? []).map((e) => ({
        id: e.id,
        title: "Rate decision",
        currency: "USD",
        severity: e.severity ?? "HIGH",
        eventTimeIso: "2026-06-07T01:00:00.000Z",
        countdownSeconds: 3600,
        state: "UPCOMING",
        affectsSymbol: e.affects ?? true,
        affectedSymbols: ["EURUSD"],
      })),
      topSeverity: opts.topSeverity ?? null,
      highImpactWindowActive: opts.highImpact ?? false,
      summary: "",
    },
    behavior: { mode: "NORMAL", note: "" },
  } as unknown as NewsResult;
}

function scannerStub(opts: {
  sufficient?: boolean;
  direction?: "BUY" | "SELL" | "NONE";
  bias?: string;
  lifecycleStage?: string;
  entryFrom?: number;
  entryTo?: number;
  stopLoss?: number | null;
  invalidation?: number | null;
  tp?: number[];
} = {}): ScannerResult {
  return {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    timeframe: "M15",
    generatedAt: "2026-06-07T00:00:00.000Z",
    hasSufficientData: opts.sufficient ?? true,
    bias: opts.bias ?? "BULLISH",
    direction: opts.direction ?? "BUY",
    lifecycleStage: opts.lifecycleStage ?? "ENTRY_WINDOW_OPEN",
    entryZone: { from: opts.entryFrom ?? 1.0998, to: opts.entryTo ?? 1.1002 },
    stopLoss: opts.stopLoss === undefined ? 1.0992 : opts.stopLoss,
    invalidationPrice:
      opts.invalidation === undefined ? 1.0992 : opts.invalidation,
    takeProfitZones: (opts.tp ?? [1.1012]).map((m) => ({
      from: m - 0.0002,
      to: m + 0.0002,
    })),
  } as unknown as ScannerResult;
}

function scalpStub(opts: {
  blind?: boolean;
  direction?: "BUY" | "SELL" | null;
  status?: string;
  flameStage?: string;
  readDirection?: "BUY" | "SELL" | "NONE";
} = {}): ScalpResult {
  return {
    symbol: "EURUSD",
    direction: opts.direction === undefined ? "BUY" : opts.direction,
    status: opts.status ?? "READY",
    expiresAt: "2026-06-07T00:01:00.000Z",
    validForSeconds: 60,
    flame: {
      blind: opts.blind ?? false,
      readDirection: opts.readDirection ?? "BUY",
      flameStage: opts.flameStage ?? "IGNITING",
    },
  } as unknown as ScalpResult;
}

function timingStub(opts: {
  quality?: string;
  bias?: "BUY" | "SELL" | "NEUTRAL";
  grade?: string;
  entryPermission?: string;
} = {}): TimingResult {
  return {
    dataQuality: { label: opts.quality ?? "good" },
    pressureBias: opts.bias ?? "BUY",
    timingGrade: opts.grade ?? "A",
    entryPermission: opts.entryPermission ?? "ENTER_NOW",
    generatedAt: "2026-06-07T00:00:00.000Z",
  } as unknown as TimingResult;
}

// `undefined` → healthy default stub; `null` → the SOURCE rejected (absent).
function dep<T>(val: T | null | undefined, def: () => T): () => Promise<T> {
  return async () => {
    if (val === undefined) return def();
    if (val === null) throw new Error("source failed");
    return val;
  };
}

interface DepOpts {
  chart?: ChartResult | null;
  news?: NewsResult | null;
  scanner?: ScannerResult | null;
  scalp?: ScalpResult | null;
  timing?: TimingResult | null;
}

function makeDeps(
  o: DepOpts = {},
  spy?: { timingReqs: unknown[] },
): Partial<TruthSnapshotDeps> {
  return {
    getChartCandlesFn: dep(o.chart, () => chartStub()),
    buildNewsFn: dep(o.news, () => newsStub()),
    buildScannerFn: dep(o.scanner, () => scannerStub()),
    evaluateScalpFn: dep(o.scalp, () => scalpStub()),
    computeTimingFn: (async (req: { persistSnapshot?: boolean }) => {
      spy?.timingReqs.push(req);
      if (o.timing === null) throw new Error("source failed");
      return o.timing === undefined ? timingStub() : o.timing;
    }),
  } as Partial<TruthSnapshotDeps>;
}

const USER_ID = 1;
const build = (o: DepOpts = {}, spy?: { timingReqs: unknown[] }) =>
  buildSymbolTruthSnapshot("EURUSD", "M15", USER_ID, makeDeps(o, spy));

// Walk every user-facing string field of the snapshot (excludes raw `source`,
// the symbol/timeframe identifiers, ISO timestamps, and event ids — none of
// which are rendered as prose).
function userFacingStrings(s: SymbolTruthSnapshot): string[] {
  const out: string[] = [
    s.verdict.headline,
    s.verdict.bestActionText,
    ...s.verdict.evidenceFor,
    ...s.verdict.evidenceAgainst,
    s.components.scanner.label,
    s.components.flame.label,
    s.components.timing.label,
    s.components.scalp.label,
    s.news.riskLabel,
    s.data.sourceLabel ?? "",
    s.levels.withheldReason ?? "",
  ];
  if (s.news.disclaimer) out.push(s.news.disclaimer);
  for (const e of s.news.events) out.push(e.title, e.severityLabel);
  return out.filter((x) => x.length > 0);
}

const UPPER_SNAKE = /[A-Z0-9]+_[A-Z0-9_]+/;

// ── 1. stale-levels guard (pure rule + brain integration) ────────────────────

test("stale-levels guard withholds geometry far from price", () => {
  // Percentage trip: a level 10% from price.
  assert.equal(
    evaluateLevelStaleness({
      price: 1.1,
      levels: { entryFrom: 1.21, entryTo: null, stopLoss: null, invalidation: null, takeProfit: [] },
    }).stale,
    true,
  );
  // ATR trip: within 2% but beyond 8 ATRs of a tight ATR.
  assert.equal(
    evaluateLevelStaleness({
      price: 1.1,
      atr: 0.001,
      levels: { entryFrom: 1.118, entryTo: null, stopLoss: null, invalidation: null, takeProfit: [] },
    }).stale,
    true,
  );
  // Within both bounds → not stale.
  assert.equal(
    evaluateLevelStaleness({
      price: 1.1,
      atr: 0.01,
      levels: { entryFrom: 1.0995, entryTo: 1.1005, stopLoss: 1.099, invalidation: null, takeProfit: [1.101] },
    }).stale,
    false,
  );
  // No price → cannot judge, never withhold on this basis alone.
  assert.equal(
    evaluateLevelStaleness({
      price: null,
      levels: { entryFrom: 99, entryTo: null, stopLoss: null, invalidation: null, takeProfit: [] },
    }).stale,
    false,
  );
});

test("brain withholds stale levels end-to-end and degrades the action", async () => {
  // Scanner geometry parked ~10% from a live price → the guard must withhold
  // every actionable level and the BUY must degrade to watch-only.
  const snap = await build({
    chart: chartStub({ state: "LIVE_CONFIRMED", price: 1.1 }),
    scanner: scannerStub({
      direction: "BUY",
      entryFrom: 1.2,
      entryTo: 1.205,
      stopLoss: 1.19,
      invalidation: 1.19,
      tp: [1.22],
    }),
  });
  assert.equal(snap.levels.withheld, true);
  assert.equal(snap.levels.entryFrom, null);
  assert.equal(snap.levels.stopLoss, null);
  assert.deepEqual(snap.levels.takeProfit, []);
  assert.ok(snap.levels.withheldReason && snap.levels.withheldReason.length > 0);
  assert.notEqual(snap.verdict.bestAction, "BUY");
  assert.notEqual(snap.verdict.bestAction, "SELL");
});

test("READABILITY: too few bars withhold the trade idea and neutralize bias", async () => {
  // A live-confirmed feed with VALID, near-price (not stale) geometry, but fewer
  // closed bars than the shared minimum → the snapshot must show NO directional
  // read and withhold the actionable setup with an honest reason. This is the
  // readability contract acting purely on display; the live execution gates are
  // never consulted here.
  const snap = await build({
    chart: chartStub({ state: "LIVE_CONFIRMED", price: 1.1, bars: 3 }),
    scanner: scannerStub({
      direction: "BUY",
      entryFrom: 1.0998,
      entryTo: 1.1002,
      stopLoss: 1.0992,
      invalidation: 1.0992,
      tp: [1.1012],
    }),
  });
  // Bias/stage are honestly UNKNOWN — never a direction off too little data.
  assert.equal(snap.verdict.bias, "UNKNOWN");
  assert.equal(snap.verdict.stage, "UNKNOWN");
  assert.notEqual(snap.verdict.bestAction, "BUY");
  assert.notEqual(snap.verdict.bestAction, "SELL");
  // The trade idea is withheld even though the geometry is NOT stale.
  assert.equal(snap.levels.withheld, true);
  assert.equal(snap.levels.entryFrom, null);
  assert.equal(snap.levels.stopLoss, null);
  assert.deepEqual(snap.levels.takeProfit, []);
  assert.ok(snap.levels.withheldReason && snap.levels.withheldReason.length > 0);
  // No invalidation side is exposed without a readable setup.
  assert.equal(snap.verdict.invalidation, null);
});

// ── 2. one freshness ─────────────────────────────────────────────────────────

test("one freshness: a single data.state drives the verdict", async () => {
  const live = await build({ chart: chartStub({ state: "LIVE_CONFIRMED" }) });
  assert.equal(live.data.state, "LIVE_CONFIRMED");

  // A stale feed yields exactly one freshness verdict, and the composer's
  // action precedence reads THAT one value (non-live ⇒ wait for data).
  const stale = await build({ chart: chartStub({ state: "STALE" }) });
  assert.equal(stale.data.state, "STALE");
  assert.equal(stale.verdict.bestAction, "WAIT_FOR_DATA");

  const gone = await build({ chart: chartStub({ state: "UNAVAILABLE" }) });
  assert.equal(gone.data.state, "UNAVAILABLE");
  assert.equal(gone.verdict.bestAction, "WAIT_FOR_DATA");
});

// ── 3. one news state ────────────────────────────────────────────────────────

test("one news state: provider flag + a single disclaimer", async () => {
  const off = await build({ news: newsStub({ connected: false }) });
  assert.equal(off.news.providerConnected, false);
  assert.deepEqual(off.news.events, []);
  assert.ok(off.news.disclaimer && off.news.disclaimer.length > 0);

  const on = await build({
    news: newsStub({ connected: true, topSeverity: "HIGH", events: [{ id: "e1" }] }),
  });
  assert.equal(on.news.providerConnected, true);
  assert.equal(on.news.disclaimer, null);
  assert.equal(on.news.events.length, 1);
});

// ── 3b. news events pass currency / raw severity / lifecycle state through ────

test("news events pass currency, raw severity, and lifecycle state through", async () => {
  // Task #515 — the chart markers, toasts, and Impact Radar strip read these
  // fields off the ONE snapshot. The brain must pass them through verbatim from
  // the radar event (no surface re-derivation), alongside the clean-English
  // severityLabel it already produced.
  const snap = await build({
    news: newsStub({
      connected: true,
      topSeverity: "HIGH",
      events: [{ id: "e1", severity: "CRITICAL" }],
    }),
  });
  assert.equal(snap.news.events.length, 1);
  const ev = snap.news.events[0]!;
  assert.equal(ev.currency, "USD");
  assert.equal(ev.severity, "CRITICAL");
  assert.equal(ev.state, "UPCOMING");
  // The clean-English label is still produced (and carries no raw enum token).
  assert.equal(ev.severityLabel, "Critical");
  assert.ok(!UPPER_SNAKE.test(ev.severityLabel));
});

// ── 4. evidence honesty (pure composer) ──────────────────────────────────────

test("evidence honesty: only present+aligned components are cited", () => {
  const v = composeVerdict({
    dataState: "LIVE_CONFIRMED",
    price: 1.1,
    highImpactWindowActive: false,
    levels: { entryFrom: 1.0998, entryTo: 1.1002, stopLoss: 1.099, invalidation: null, takeProfit: [1.101] },
    atr: 1,
    components: [
      { key: "scanner", present: true, alignment: "BULLISH", label: "x", asOf: null },
      // Absent component: must NEVER appear in either evidence list.
      { key: "flame", present: false, alignment: "UNKNOWN", label: "x", asOf: null },
      { key: "timing", present: true, alignment: "BEARISH", label: "x", asOf: null },
      { key: "scalp", present: true, alignment: "BULLISH", label: "x", asOf: null },
    ],
  });
  assert.equal(v.bias, "CONFLICT");
  // Both sides carried — we never silently pick a winner.
  assert.ok(v.evidenceFor.length >= 1);
  assert.ok(v.evidenceAgainst.length >= 1);
  const all = [...v.evidenceFor, ...v.evidenceAgainst].join(" | ");
  // The flame sentence (momentum) is the absent component → never cited.
  assert.ok(!/momentum/i.test(all));
  // The scanner + scalp (bull) and timing (bear) sentences ARE present.
  assert.ok(v.evidenceFor.some((s) => /scanner/i.test(s)));
  assert.ok(v.evidenceFor.some((s) => /scalp/i.test(s)));
  assert.ok(v.evidenceAgainst.some((s) => /timing/i.test(s)));
});

// ── 5. invalidation geometry (pure composer) ─────────────────────────────────

test("invalidation side is derived purely from level geometry", () => {
  const base = {
    dataState: "LIVE_CONFIRMED" as const,
    price: 1.1,
    highImpactWindowActive: false,
    atr: 1,
  };
  const bull = composeVerdict({
    ...base,
    levels: { entryFrom: 1.0998, entryTo: 1.1002, stopLoss: 1.099, invalidation: null, takeProfit: [1.101] },
    components: [{ key: "scanner", present: true, alignment: "BULLISH", label: "x", asOf: null }],
  });
  assert.equal(bull.invalidation?.side, "BELOW");

  const bear = composeVerdict({
    ...base,
    levels: { entryFrom: 1.0998, entryTo: 1.1002, stopLoss: 1.101, invalidation: null, takeProfit: [1.099] },
    components: [{ key: "scanner", present: true, alignment: "BEARISH", label: "x", asOf: null }],
  });
  assert.equal(bear.invalidation?.side, "ABOVE");
});

// ── 6. strength / label consistency ──────────────────────────────────────────

test("strength labels are clean, single-sourced, and deterministic", async () => {
  const a = await build();
  const b = await build();
  // Each component has exactly one clean-English label.
  assert.equal(a.components.scanner.label, "Bullish · Entry window open");
  assert.equal(a.components.flame.label, "Igniting");
  assert.equal(a.components.scalp.label, "Ready (long)");
  assert.equal(a.components.timing.label, "Grade A · Enter now");
  // Same inputs → byte-identical snapshot (generatedAt aside) so two surfaces
  // can never render different words.
  const strip = (s: SymbolTruthSnapshot) => {
    const { generatedAt, ...rest } = s;
    void generatedAt;
    return JSON.stringify(rest);
  };
  assert.equal(strip(a), strip(b));
});

// ── 7. no internal strings reach user copy ───────────────────────────────────

test("no UPPER_SNAKE enum tokens leak into user-facing copy", async () => {
  const snap = await build({
    scanner: scannerStub({ lifecycleStage: "ENTRY_WINDOW_OPEN", bias: "BULLISH" }),
    scalp: scalpStub({ status: "READY", flameStage: "RUN_ON" }),
    timing: timingStub({ entryPermission: "ENTER_NOW", grade: "A" }),
    news: newsStub({ connected: true, topSeverity: "HIGH", events: [{ id: "e1", severity: "HIGH" }] }),
  });
  for (const s of userFacingStrings(snap)) {
    assert.ok(!UPPER_SNAKE.test(s), `leaked internal token in: "${s}"`);
  }
});

// ── 4b. absent SOURCE end-to-end (brain) ─────────────────────────────────────

test("a rejected SOURCE becomes an absent component, never cited as evidence", async () => {
  // The scanner resolver throws → the brain must degrade it to an absent
  // component (present:false), never a fabricated value, and never cite it.
  const snap = await build({ scanner: null });
  assert.equal(snap.components.scanner.present, false);
  const evidence = [...snap.verdict.evidenceFor, ...snap.verdict.evidenceAgainst].join(" | ");
  assert.ok(!/scanner/i.test(evidence), `absent scanner must not be cited: ${evidence}`);
});

// ── (+) no-heat-write deps spy (read-side only) ──────────────────────────────

test("snapshot computes timing with persistSnapshot:false (no heat write)", async () => {
  const spy = { timingReqs: [] as unknown[] };
  await build({}, spy);
  assert.equal(spy.timingReqs.length, 1);
  const req = spy.timingReqs[0] as { persistSnapshot?: boolean };
  // The brain must request the timing read WITHOUT persisting a heat snapshot —
  // proof the read-side snapshot writes nothing on the timing path.
  assert.equal(req.persistSnapshot, false);
});
