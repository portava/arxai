// Chart-pattern detection quality, measured.
//
// The pattern engine (lib/domain chart-patterns/patternEngine.ts) draws levels
// on the user's chart and labels them. The owner's ruling is that every read and
// drawing must be accurate, so each claim below is measured, not asserted:
//
//   1. PLANTED RECALL. A textbook instance of every pattern is planted in seeded
//      price paths (random jitter of every waypoint, per-bar noise, five quote
//      scales from 0.65 to 43,250). The detector must name it (id and bias), give
//      the planted status, and put the confirmation level within 0.25 ATR of the
//      planted level.
//   2. NEAR-MISS REJECTION. The same paths with the one defining feature broken
//      (head not prominent, tops not level, the flag drifting WITH the pole, a
//      wick that closes beyond the level, a level broken long before the window,
//      a body that does not engulf, a wick that is not long enough, a base that
//      is not compressed). The detector must NOT name the pattern.
//   3. CONSISTENCY ON REAL BARS. Every pattern on every 150-bar window of the
//      real-markets-v1 fixture (step 1): levels strictly ordered for the bias,
//      status agreeing with the last close vs the displayed levels, key points
//      inside the window.
//   4. SCALE INVARIANCE. The same real windows with every price shifted by a
//      power of ten give the same patterns, statuses and key points, and levels
//      equal to the scaled originals within one quote tick.
//   5. FORWARD OUTCOMES. Each pattern, entered at the close of the bar it first
//      becomes actionable, is followed until its target or its invalidation is
//      touched (100 bars at most). A driftless price hits the target first with
//      probability p0 = stopDistance / (stopDistance + targetDistance), so a
//      pattern only carries information if its hit rate beats p0. Tested per
//      pattern and timeframe, Benjamini-Hochberg at q = 0.05.
//
// Prints a summary; --markdown <path> writes the generated part of the doc.
// Pinned fixture + seeded generator: no DB, no network, no clock.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { controlFdr, stableStringify } from "@workspace/discovery";
import { normalSf } from "@workspace/risk";
import { atr, detectChartPatterns, quoteDecimals, type ChartPatternCandle } from "@workspace/domain/chart-patterns";
import type { DetectedPattern } from "@workspace/domain/market";
import { loadVerifiedMarketsFixture } from "./marketsHistoryFixture.js";

export const PATTERN_QUALITY_VERSION = "arx-pattern-quality-v1";
export const WINDOW = 150;
export const LEVEL_TOLERANCE_ATR = 0.25;
export const PLANTED_TRIALS = 200;
export const OUTCOME_HORIZON = 100;
const Q = 0.05;
const MIN_OUTCOMES = 30;

// ── 1-2. Planted patterns ────────────────────────────────────────────────────

export type PlantFamily = "hs" | "double" | "flag" | "sweep" | "breakout" | "engulfing" | "pin" | "flare";
export const PLANT_FAMILIES: readonly PlantFamily[] = ["hs", "double", "flag", "sweep", "breakout", "engulfing", "pin", "flare"];

/** The canonical id is the bias the family is drawn in; the mirror image is the other id. */
const FAMILY_IDS: Record<PlantFamily, { canonical: string; mirrored: string; canonicalBias: "bullish" | "bearish"; status: string; nearMiss: string }> = {
  hs: { canonical: "head_and_shoulders", mirrored: "inverse_head_and_shoulders", canonicalBias: "bearish", status: "confirmed", nearMiss: "head only 0.1 units above the shoulders (not prominent)" },
  double: { canonical: "double_top", mirrored: "double_bottom", canonicalBias: "bearish", status: "confirmed", nearMiss: "second top 3 units below the first (not level)" },
  flag: { canonical: "bull_flag", mirrored: "bear_flag", canonicalBias: "bullish", status: "confirmed", nearMiss: "the flag drifts WITH the pole (no pullback)" },
  sweep: { canonical: "liquidity_sweep_high", mirrored: "liquidity_sweep_low", canonicalBias: "bearish", status: "confirmed", nearMiss: "the wick takes the high and the bar CLOSES above it (a breakout, not a sweep)" },
  breakout: { canonical: "breakout_retest_up", mirrored: "breakout_retest_down", canonicalBias: "bullish", status: "confirmed", nearMiss: "the level was broken 15+ bars earlier and price never came back through it" },
  engulfing: { canonical: "bearish_engulfing", mirrored: "bullish_engulfing", canonicalBias: "bearish", status: "forming", nearMiss: "the last body is smaller than the prior one (no engulf)" },
  pin: { canonical: "bearish_pin_bar", mirrored: "bullish_pin_bar", canonicalBias: "bearish", status: "forming", nearMiss: "the wick is 1.5x the body (a pin needs 2x)" },
  flare: { canonical: "scalp_flare_up", mirrored: "scalp_flare_down", canonicalBias: "bullish", status: "confirmed", nearMiss: "the base is not compressed (base bars as wide as the market)" },
};

/** Quote scales: (base price, decimals) of an FX major, a JPY cross, gold, a 5-dp minor, and an index/crypto. */
const SCALES: ReadonlyArray<[number, number]> = [[1.08451, 5], [151.234, 3], [2650.55, 2], [0.65234, 5], [43250.5, 1]];
const WICK = 0.08;

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

interface UBar { o: number; h: number; l: number; c: number }

/** Linear path through (bar, level) waypoints with N(0, noise) on every non-waypoint close. */
function pathBars(points: ReadonlyArray<[number, number]>, noise: number, rnd: () => number): UBar[] {
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const closes: number[] = [];
  for (let k = 0; k + 1 < points.length; k++) {
    const [b0, v0] = points[k]!;
    const [b1, v1] = points[k + 1]!;
    for (let b = b0; b < b1; b++) closes.push(v0 + ((v1 - v0) * (b - b0)) / (b1 - b0) + (b === b0 ? 0 : gauss() * noise));
  }
  closes.push(points[points.length - 1]![1]);
  return closes.map((c, i) => bar(i === 0 ? c : closes[i - 1]!, c));
}

/**
 * A bar with explicit open/close. The full wick sits on the CLOSE side and half
 * a wick on the open side, so the bar after a turning point never ties its
 * extreme (a bar that opens at a peak cannot print the same high as the peak).
 */
function bar(o: number, c: number, h?: number, l?: number): UBar {
  const up = c >= o;
  return { o, c, h: h ?? (up ? c + WICK : o + WICK / 2), l: l ?? (up ? o - WICK / 2 : c - WICK) };
}

interface Planted { units: UBar[]; truth: number }

/** One planted instance in UNIT space, canonical orientation. `truth` is the planted confirmation level. */
export function plantUnits(family: PlantFamily, nearMiss: boolean, rnd: () => number): Planted {
  const j = (a: number) => (rnd() * 2 - 1) * a; // uniform jitter in [-a, a]
  const ji = (a: number) => Math.round(j(a));
  switch (family) {
    case "hs": {
      const ls = 16 + j(0.2), rs = ls + j(0.2);
      const t1 = 10 + j(0.3), t2 = 10 + j(0.3);
      const head = nearMiss ? Math.max(ls, rs) + 0.1 : 21 + j(0.5);
      const pts: Array<[number, number]> = [[0, 4], [24 + ji(2), ls], [32 + ji(1), t1], [42 + ji(2), head], [52 + ji(1), t2], [60 + ji(1), rs], [68, Math.min(t1, t2) - 1.5]];
      return { units: pathBars(pts, 0.1, rnd), truth: (t1 + t2) / 2 - WICK };
    }
    case "double": {
      const a = 18 + j(0.3), b = nearMiss ? a - 3 : a + j(0.15), t = 11 + j(0.4);
      const pts: Array<[number, number]> = [[0, 6], [22 + ji(2), a], [32 + ji(2), t], [44 + ji(2), b], [52, t - 1.5]];
      return { units: pathBars(pts, 0.1, rnd), truth: t - WICK };
    }
    case "flag": {
      // Exact layout the detector defines: pole = 8 bars, flag box = 5 bars, last bar = the break.
      const lead = pathBars([[0, 8], [31, 10]], 0.1, rnd);
      const step = 1 + j(0.2);
      let prev = lead[lead.length - 1]!.c;
      const out = [...lead];
      for (let k = 1; k <= 7; k++) { const c = 10 + step * k; out.push(bar(prev, c)); prev = c; }
      const drift = (nearMiss ? 1 : -1) * (0.25 + j(0.05));
      const flagStart = out.length;
      for (let k = 1; k <= 5; k++) { const c = prev + drift; out.push(bar(prev, c)); prev = c; }
      const flagHigh = Math.max(...out.slice(flagStart).map((x) => x.h));
      out.push(bar(prev, flagHigh + 0.6 + j(0.1)));
      return { units: out, truth: flagHigh };
    }
    case "sweep": {
      const p = 20 + j(0.3);
      const out = pathBars([[0, 10], [16 + ji(2), p], [28 + ji(2), 13], [44, 18.5 + j(0.3)]], 0.1, rnd);
      const prev = out[out.length - 1]!.c;
      const top = p + WICK + 0.6 + j(0.15);
      const close = nearMiss ? p + WICK + 0.3 : p - 0.8;
      out.push(bar(prev, close, top, Math.min(prev, close) - 0.05));
      return { units: out, truth: p + WICK };
    }
    case "breakout": {
      const r1 = 20 + j(0.1), r2 = 20 + j(0.1), r3 = 20 + j(0.1);
      const pts: Array<[number, number]> = [[0, 12], [14, r1], [20, 16], [26, r2], [32, 16], [38, r3], [44, 15.5], [52, 19.6]];
      const out = pathBars(pts, 0.05, rnd);
      const level = (r1 + r2 + r3) / 3 + WICK;
      const post: Array<[number, number]> = nearMiss
        ? [[52, 19.6], [53, 21.2], [56, 22.5], [59, 21.6], [75, 23.5]]
        : [[52, 19.6], [53, 21.2], [56, 22.5], [59, level + 0.25], [60, level + 0.8]];
      const tail = pathBars(post, 0.05, rnd).slice(1);
      tail[0] = bar(19.6, 21.2);
      return { units: [...out, ...tail], truth: level };
    }
    case "engulfing": {
      const out = pathBars([[0, 10], [37, 17.6 + j(0.1)]], 0.1, rnd);
      const p = out[out.length - 1]!.c;
      out.push(bar(p, p + 0.4));
      const close = nearMiss ? p + 0.4 - 0.35 : p - 0.3 - j(0.1) - 0.1;
      const last = bar(p + 0.5, close);
      out.push(last);
      return { units: out, truth: last.l };
    }
    case "pin": {
      const out = pathBars([[0, 10], [38, 18 + j(0.1)]], 0.1, rnd);
      const o = out[out.length - 1]!.c;
      const last = nearMiss
        ? bar(o, o - 0.4, o + 0.6, o - 0.44)
        : bar(o, o - 0.08, o + 1 + j(0.1), o - 0.12);
      out.push(last);
      return { units: out, truth: last.l };
    }
    case "flare": {
      // Lead-in with real bar-to-bar movement so ATR reflects a live market.
      const out: UBar[] = [];
      let prev = 6;
      for (let k = 0; k < 30; k++) { const c = 6 + k * (4 / 30) + (k % 2 === 0 ? 0.35 : -0.35) + j(0.05); out.push(bar(prev, c)); prev = c; }
      out.push(bar(prev, 10)); // settle onto the base level
      prev = 10;
      const baseStart = out.length;
      for (let k = 0; k < 6; k++) {
        const c = nearMiss ? 10 + (k % 2 === 0 ? 0.5 : -0.5) : 10 + j(0.05);
        out.push(nearMiss ? bar(prev, c) : bar(prev, c, Math.max(prev, c) + 0.05, Math.min(prev, c) - 0.05));
        prev = c;
      }
      const baseHigh = Math.max(...out.slice(baseStart).map((x) => x.h));
      out.push(bar(prev, baseHigh + 1.0 + j(0.1), undefined, prev - 0.05));
      return { units: out, truth: baseHigh };
    }
  }
}

/** Map unit bars to prices at a quote scale, optionally mirrored (bullish <-> bearish), rounded to the quote's decimals. */
export function toCandles(units: UBar[], base: number, decimals: number, mirror: boolean): ChartPatternCandle[] {
  const u = base * 0.0015;
  const px = (x: number) => Number((base + (mirror ? -(x - 12) : x - 12) * u).toFixed(decimals));
  return units.map((b) => ({
    open: px(b.o), close: px(b.c), high: mirror ? px(b.l) : px(b.h), low: mirror ? px(b.h) : px(b.l), isComplete: true, isForming: false,
  }));
}

export interface PlantedRow {
  id: string; bias: string; family: PlantFamily; expectedStatus: string; nearMiss: string;
  trials: number; recalled: number; wrongStatus: number; levelOff: number; missed: number;
  maxLevelErrorAtr: number; rejected: number; falseFires: number;
}

export function runPlantedSuite(trials = PLANTED_TRIALS): PlantedRow[] {
  const rows: PlantedRow[] = [];
  PLANT_FAMILIES.forEach((family, fi) => {
    const spec = FAMILY_IDS[family];
    for (const mirror of [false, true]) {
      const id = mirror ? spec.mirrored : spec.canonical;
      const bias = mirror ? (spec.canonicalBias === "bullish" ? "bearish" : "bullish") : spec.canonicalBias;
      const row: PlantedRow = { id, bias, family, expectedStatus: spec.status, nearMiss: spec.nearMiss, trials, recalled: 0, wrongStatus: 0, levelOff: 0, missed: 0, maxLevelErrorAtr: 0, rejected: 0, falseFires: 0 };
      for (let k = 0; k < trials; k++) {
        const [base, dec] = SCALES[k % SCALES.length]!;
        const seed = 1 + fi * 100003 + (mirror ? 50021 : 0) + k * 7919;
        // Textbook instance.
        const planted = plantUnits(family, false, rng(seed));
        const candles = toCandles(planted.units, base, dec, mirror);
        const truth = toCandles([{ o: planted.truth, h: planted.truth, l: planted.truth, c: planted.truth }], base, dec, mirror)[0]!.close;
        const a = atr(candles, 14)!;
        const hit = detectChartPatterns(candles).patterns.find((p) => p.id === id && p.bias === bias);
        if (!hit) row.missed++;
        else {
          const err = Math.abs(hit.levels.confirmation! - truth) / a;
          row.maxLevelErrorAtr = Math.max(row.maxLevelErrorAtr, err);
          if (hit.status !== spec.status) row.wrongStatus++;
          else if (err > LEVEL_TOLERANCE_ATR) row.levelOff++;
          else row.recalled++;
        }
        // Near miss: same generator, the defining feature broken.
        const miss = toCandles(plantUnits(family, true, rng(seed)).units, base, dec, mirror);
        if (detectChartPatterns(miss).patterns.some((p) => p.id === id)) row.falseFires++;
        else row.rejected++;
      }
      rows.push(row);
    }
  });
  return rows;
}

// ── 3-5. Real bars ───────────────────────────────────────────────────────────

export interface ConsistencyRow {
  id: string; emitted: number; fireRate: number; status: Record<string, number>;
  badLevels: number; badStatus: number; badKeyPoints: number;
}

export interface OutcomeRow {
  key: string; id: string; timeframe: string; bias: string;
  entries: number; resolved: number; timeouts: number; ambiguous: number;
  hits: number; hitRate: number; meanP0: number; excess: number; t: number; p: number;
  meanR: number; fdrRejected: boolean;
}

const LOW_PRECISION_CATEGORIES = new Set(["candlestick", "breakout_retest"]);

/** Is the status consistent with where the last close sits vs the displayed levels? */
function statusConsistent(p: DetectedPattern, lastClose: number): boolean {
  const cf = p.levels.confirmation!;
  const inv = p.levels.invalidation!;
  const bull = p.bias === "bullish";
  const beyond = bull ? lastClose > cf : lastClose < cf;
  const pastInv = bull ? lastClose < inv : lastClose > inv;
  if (p.status === "confirmed" && !beyond) return false;
  // Candlestick and breakout-retest statuses depend on more than the last close
  // vs confirmation (follow-through, the retest), so "forming beyond" is allowed.
  if (p.status === "forming" && beyond && !LOW_PRECISION_CATEGORIES.has(p.category)) return false;
  if (p.status === "invalidated" && !pastInv) return false;
  return true;
}

function levelsOrdered(p: DetectedPattern): boolean {
  const cf = p.levels.confirmation;
  const inv = p.levels.invalidation;
  const t = p.levels.targets[0];
  if (cf == null || inv == null || t == null) return false;
  return p.bias === "bullish" ? inv < cf && cf < t : inv > cf && cf > t;
}

/** Shift every price by 10^k exactly in decimal (no float drift in the quote). */
function decimalShift(v: number, k: number): number {
  const s = String(v);
  const dot = s.indexOf(".");
  const d = dot < 0 ? 0 : s.length - dot - 1;
  return Number((v * 10 ** k).toFixed(Math.max(0, d - k)));
}

/** A pattern instance identity: its id and the absolute bar index of its first key point. */
const instanceKey = (p: DetectedPattern, offset: number) => `${p.id}@${offset + p.keyPoints[0]!.index}`;

function tTest(xs: readonly number[]): { n: number; mean: number; t: number; p: number } {
  const n = xs.length;
  if (n < 2) return { n, mean: n ? xs[0]! : 0, t: 0, p: 1 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  if (!(v > 0)) return { n, mean, t: 0, p: 1 };
  const t = mean / Math.sqrt(v / n);
  return { n, mean, t, p: Math.min(1, 2 * normalSf(Math.abs(t))) };
}

export function runRealDataQuality(fixturesRoot = new URL("../../fixtures", import.meta.url).pathname) {
  const { manifest, instruments } = loadVerifiedMarketsFixture(fixturesRoot);
  const cons = new Map<string, ConsistencyRow>();
  let windows = 0;
  let scaleWindows = 0;
  let scaleMismatches = 0;
  const scaleExamples: string[] = [];
  interface Acc { id: string; timeframe: string; bias: string; entries: number; timeouts: number; ambiguous: number; win: number[]; p0: number[]; r: number[] }
  const acc = new Map<string, Acc>();

  for (const inst of instruments) {
    const c: ChartPatternCandle[] = inst.bars.map((b) => ({ open: b.open, high: b.high, low: b.low, close: b.close, isComplete: true, isForming: false }));
    // Scale by 1/100 for prices >= 100 and x100 below, so decimals stay within the 6-digit cap.
    const k = c[0]!.close >= 100 ? -2 : 2;
    const seen = new Set<string>();
    const busyUntil = new Map<string, number>();
    for (let e = WINDOW; e <= c.length; e++) {
      windows++;
      const offset = e - WINDOW;
      const win = c.slice(offset, e);
      const last = win[WINDOW - 1]!;
      const res = detectChartPatterns(win);
      for (const p of res.patterns) {
        const row = cons.get(p.id) ?? { id: p.id, emitted: 0, fireRate: 0, status: {}, badLevels: 0, badStatus: 0, badKeyPoints: 0 };
        cons.set(p.id, row);
        row.emitted++;
        row.status[p.status] = (row.status[p.status] ?? 0) + 1;
        if (!levelsOrdered(p)) row.badLevels++;
        if (!statusConsistent(p, last.close)) row.badStatus++;
        if (p.keyPoints.some((kp) => !Number.isInteger(kp.index) || kp.index < 0 || kp.index >= WINDOW)) row.badKeyPoints++;

        // Forward outcome: first actionable appearance of each instance, one open trade per (series, id).
        const actionable = p.status === "confirmed" || p.category === "candlestick";
        const key = instanceKey(p, offset);
        if (!actionable || seen.has(key)) continue;
        seen.add(key);
        if ((busyUntil.get(p.id) ?? -1) >= e - 1) continue;
        const bull = p.bias === "bullish";
        const entry = last.close;
        const inv = p.levels.invalidation!;
        const tgt = p.levels.targets[0]!;
        if (!(bull ? inv < entry && entry < tgt : tgt < entry && entry < inv)) continue;
        const cellKey = `${p.id}|${inst.spec.timeframe}`;
        const a = acc.get(cellKey) ?? { id: p.id, timeframe: inst.spec.timeframe, bias: p.bias, entries: 0, timeouts: 0, ambiguous: 0, win: [], p0: [], r: [] };
        acc.set(cellKey, a);
        a.entries++;
        const stopD = Math.abs(entry - inv);
        const tgtD = Math.abs(tgt - entry);
        let outcome: "win" | "loss" | "both" | null = null;
        let j = e;
        for (; j < Math.min(c.length, e + OUTCOME_HORIZON); j++) {
          const b = c[j]!;
          const hitT = bull ? b.high >= tgt : b.low <= tgt;
          const hitS = bull ? b.low <= inv : b.high >= inv;
          if (hitT && hitS) { outcome = "both"; break; }
          if (hitT) { outcome = "win"; break; }
          if (hitS) { outcome = "loss"; break; }
        }
        busyUntil.set(p.id, j);
        if (outcome === null) { a.timeouts++; continue; }
        // A bar that touches both sides cannot say which came first: excluded, counted.
        if (outcome === "both") { a.ambiguous++; continue; }
        a.win.push(outcome === "win" ? 1 : 0);
        a.p0.push(stopD / (stopD + tgtD));
        a.r.push(outcome === "win" ? tgtD / stopD : -1);
      }

      // Scale invariance on every 10th window.
      if (e % 10 === 0) {
        scaleWindows++;
        const scaled = win.map((b) => ({ ...b, open: decimalShift(b.open, k), high: decimalShift(b.high, k), low: decimalShift(b.low, k), close: decimalShift(b.close, k) }));
        const sres = detectChartPatterns(scaled);
        const sig = (ps: DetectedPattern[]) => ps.map((p) => `${p.id}|${p.bias}|${p.status}|${p.keyPoints.map((x) => x.index).join(",")}`).join(";");
        let ok = sig(res.patterns) === sig(sres.patterns);
        if (ok) {
          for (let q = 0; q < res.patterns.length; q++) {
            const o = res.patterns[q]!.levels;
            const s = sres.patterns[q]!.levels;
            // One tick of the COARSER precision: the quote's own (shifted) or the scaled chart's display.
            const tick = Math.max(10 ** (k - quoteDecimals(win)), 10 ** -quoteDecimals(scaled)) * (1 + 1e-7);
            const pairs: Array<[number, number]> = [[o.confirmation!, s.confirmation!], [o.invalidation!, s.invalidation!], [o.targets[0]!, s.targets[0]!]];
            if (pairs.some(([x, y]) => Math.abs(x * 10 ** k - y) > tick)) ok = false;
          }
        }
        if (!ok) {
          scaleMismatches++;
          if (scaleExamples.length < 5) scaleExamples.push(`${inst.spec.symbol} ${inst.spec.timeframe} @${e}: ${sig(res.patterns)} vs ${sig(sres.patterns)}`);
        }
      }
    }
  }

  const consistency = [...cons.values()].sort((a, b) => a.id.localeCompare(b.id)).map((r) => ({ ...r, fireRate: r.emitted / windows }));
  const cells = [...acc.entries()].sort(([a], [b]) => a.localeCompare(b));
  const tested = cells.filter(([, a]) => a.win.length >= MIN_OUTCOMES);
  const stats = new Map(tested.map(([key, a]) => [key, tTest(a.win.map((w, i) => w - a.p0[i]!))]));
  const fdr = controlFdr(tested.map(([key]) => ({ key, p: stats.get(key)!.p })), Q, Math.max(1, tested.length));
  const rejected = new Set(fdr.decisions.filter((d) => d.rejected).map((d) => d.key));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const outcomes: OutcomeRow[] = cells.map(([key, a]) => {
    const st = stats.get(key);
    return {
      key, id: a.id, timeframe: a.timeframe, bias: a.bias, entries: a.entries, resolved: a.win.length, timeouts: a.timeouts, ambiguous: a.ambiguous,
      hits: a.win.reduce((s, x) => s + x, 0), hitRate: mean(a.win), meanP0: mean(a.p0), excess: mean(a.win) - mean(a.p0),
      t: st?.t ?? 0, p: st?.p ?? 1, meanR: mean(a.r), fdrRejected: rejected.has(key),
    };
  });
  return { datasetHash: manifest.datasetHash, windows, consistency, scaleWindows, scaleMismatches, scaleExamples, outcomes, familySize: tested.length };
}

export function runPatternQuality(fixturesRoot?: string) {
  const planted = runPlantedSuite();
  const real = runRealDataQuality(fixturesRoot);
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  const resultHash = createHash("sha256").update(stableStringify({
    planted: planted.map((r) => [r.id, r.recalled, r.wrongStatus, r.levelOff, r.missed, r.rejected, r.falseFires, round(r.maxLevelErrorAtr)]),
    windows: real.windows,
    consistency: real.consistency.map((r) => [r.id, r.emitted, r.status, r.badLevels, r.badStatus, r.badKeyPoints]),
    scale: [real.scaleWindows, real.scaleMismatches],
    outcomes: real.outcomes.map((o) => [o.key, o.entries, o.resolved, o.timeouts, o.ambiguous, o.hits, round(o.meanP0), round(o.p), o.fdrRejected]),
  })).digest("hex");
  return { version: PATTERN_QUALITY_VERSION, planted, ...real, resultHash };
}

export type PatternQualityResult = ReturnType<typeof runPatternQuality>;

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const fmtP = (p: number) => (p < 1e-4 ? p.toExponential(1) : p.toFixed(4));

export function renderPatternQualityMarkdown(r: PatternQualityResult): string {
  const L: string[] = [];
  L.push("# Chart-pattern detection quality", "");
  L.push(`Generated by \`scripts/src/research/patternQualityResearch.ts\` (${r.version}) on a seeded generator and the pinned fixture \`real-markets-v1\` (dataset ${r.datasetHash.slice(0, 12)}…). Result hash ${r.resultHash.slice(0, 12)}…`, "");
  L.push("Pinned by `scripts/src/patternQualityTest.ts`: every number below is regenerated in CI and must match.", "");

  const tot = r.planted.reduce((s, x) => s + x.trials, 0);
  const rec = r.planted.reduce((s, x) => s + x.recalled, 0);
  const rej = r.planted.reduce((s, x) => s + x.rejected, 0);
  L.push("## 1. Planted textbook patterns: recall", "");
  L.push(`${r.planted[0]!.trials} seeded instances per pattern, across five quote scales (0.65 to 43,250). A hit needs the right id, bias and status, and the confirmation level within ${LEVEL_TOLERANCE_ATR} ATR of the planted level. Overall: ${rec} of ${tot} (${pct(rec / tot)}).`, "");
  L.push("| Pattern | Bias | Expected status | Recalled | Wrong status | Level off | Missed | Worst level error (ATR) |");
  L.push("|---|---|---|---:|---:|---:|---:|---:|");
  for (const x of r.planted) L.push(`| ${x.id} | ${x.bias} | ${x.expectedStatus} | ${x.recalled}/${x.trials} | ${x.wrongStatus} | ${x.levelOff} | ${x.missed} | ${x.maxLevelErrorAtr.toFixed(3)} |`);
  L.push("");
  L.push("## 2. Near misses: rejection", "");
  L.push(`The same seeded paths with the one defining feature broken. A pass is the pattern NOT being named. Overall: ${rej} of ${tot} rejected (${pct(rej / tot)}).`, "");
  L.push("| Pattern | Broken feature | Rejected | False fires |");
  L.push("|---|---|---:|---:|");
  for (const x of r.planted) L.push(`| ${x.id} | ${x.nearMiss} | ${x.rejected}/${x.trials} | ${x.falseFires} |`);
  L.push("");

  const bad = r.consistency.reduce((s, x) => s + x.badLevels + x.badStatus + x.badKeyPoints, 0);
  L.push("## 3. Consistency on real bars", "");
  L.push(`Every ${WINDOW}-bar window (step 1) of all ${28} series: ${r.windows.toLocaleString("en-US")} windows. Violations: ${bad}.`, "");
  L.push("| Pattern | Emitted | Share of windows | Status mix | Level order | Status vs close | Key points |");
  L.push("|---|---:|---:|---|---:|---:|---:|");
  for (const x of r.consistency) {
    const mix = Object.entries(x.status).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${v}`).join(", ");
    L.push(`| ${x.id} | ${x.emitted} | ${pct(x.fireRate)} | ${mix} | ${x.badLevels} | ${x.badStatus} | ${x.badKeyPoints} |`);
  }
  L.push("");
  L.push("## 4. Scale invariance", "");
  L.push(`Every 10th real window again with every price shifted by a power of ten (x100 below 100, /100 above): ${r.scaleWindows.toLocaleString("en-US")} windows, ${r.scaleMismatches} with a different pattern, status, key point or level (beyond one quote tick).`, "");
  if (r.scaleExamples.length) { for (const e of r.scaleExamples) L.push(`- ${e}`); L.push(""); }

  const disc = r.outcomes.filter((o) => o.fdrRejected);
  L.push("## 5. Forward outcomes vs the driftless base rate", "");
  L.push(`Entry at the close of the bar where a pattern instance first becomes actionable (status confirmed; candlestick patterns at the bar they print), one open trade per series and pattern. Followed up to ${OUTCOME_HORIZON} bars until the drawn target or the drawn invalidation is touched. p0 is the chance a driftless price touches the target first. A bar touching both sides is excluded (it cannot say which came first). Tested: cells with at least ${MIN_OUTCOMES} resolved outcomes (${r.familySize}), Benjamini-Hochberg q = ${Q}, two-sided. **${disc.length} of ${r.familySize} differ from p0.**`, "");
  L.push("| Pattern | TF | Entries | Resolved | Timeouts | Both-touch | Hit rate | Mean p0 | Excess | t | p | Mean R (gross) | FDR |");
  L.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const o of r.outcomes) {
    L.push(`| ${o.id} | ${o.timeframe} | ${o.entries} | ${o.resolved} | ${o.timeouts} | ${o.ambiguous} | ${pct(o.hitRate)} | ${pct(o.meanP0)} | ${(o.excess * 100).toFixed(1)} pt | ${o.t.toFixed(2)} | ${o.resolved >= MIN_OUTCOMES ? fmtP(o.p) : "n<30"} | ${o.meanR.toFixed(3)} | ${o.fdrRejected ? (o.excess > 0 ? "beats p0" : "below p0") : "-"} |`);
  }
  L.push("");
  return L.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = runPatternQuality();
  const i = process.argv.indexOf("--markdown");
  if (i > 0) writeFileSync(process.argv[i + 1]!, renderPatternQualityMarkdown(r) + "\n");
  console.log(JSON.stringify({
    version: r.version, resultHash: r.resultHash, windows: r.windows, scaleWindows: r.scaleWindows, scaleMismatches: r.scaleMismatches, scaleExamples: r.scaleExamples,
    planted: r.planted.map((x) => `${x.id} rec ${x.recalled}/${x.trials} ws ${x.wrongStatus} lo ${x.levelOff} miss ${x.missed} maxErr ${x.maxLevelErrorAtr.toFixed(3)} rej ${x.rejected} ff ${x.falseFires}`),
    violations: r.consistency.reduce((s, x) => s + x.badLevels + x.badStatus + x.badKeyPoints, 0),
    outcomes: r.outcomes.map((o) => `${o.key} n ${o.resolved} hit ${pct(o.hitRate)} p0 ${pct(o.meanP0)} t ${o.t.toFixed(2)} R ${o.meanR.toFixed(3)} ${o.fdrRejected ? "FDR" : ""}`),
  }, null, 2));
}
