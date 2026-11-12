// Slow-horizon DIRECTION research: does anything predict which way a currency
// moves over the next MONTH, on 55 years of real data?
//
// Every short-horizon direction test so far found nothing (session hours, seven
// strategy families, sixteen chart patterns: 0 of ~1,950 survive). The two
// directional effects with decades of published evidence are slow ones:
//   - time-series momentum: a currency that rose over the past k months tends
//     to keep rising next month;
//   - carry: a currency whose short rate is above the dollar's tends to earn
//     that differential (it does not depreciate it away).
//
// PRE-REGISTERED (fixed in this file before any result existed):
//   Data      slow-history-v1: 9 currencies vs USD, H.10 month-end fixings,
//             OECD/IMF monthly short rates (first available series per month,
//             forward-filled at most 3 months; a currency-month without a rate
//             for either side is excluded everywhere).
//   Return    excess return of holding the currency for month m+1:
//             ln(S[m+1]/S[m]) + (i_ccy[m] - i_usd[m]) / 1200, S in USD per unit.
//             Everything a signal uses is known at the end of month m.
//   Signals   position for month m+1, decided at the end of month m:
//             TSMOM_k (k = 1, 3, 6, 12): sign of the summed excess return of
//             months m-k+1..m;  CARRY: sign(i_ccy[m] - i_usd[m]).
//   Family    per currency x 5 signals (45), plus 8 equal-weight portfolios:
//             TSMOM_k (4), CARRY (1), cross-sectional carry and cross-sectional
//             momentum 3m / 12m (long the top third, short the bottom third;
//             months with fewer than 6 currencies are skipped) (3). 53 tests.
//   Cost      1 bp of notional per unit traded (twice the intraday FX
//             assumption); every reported return is net. Sensitivity at 5 bp.
//   Split     discovery = holding months before 2000-01, confirmation = 2000-01
//             onward. A hypothesis SURVIVES only if it is a Benjamini-Hochberg
//             discovery (q = 0.05, family 53) on the first half AND keeps its
//             sign with p < 0.05 on the second half.
//   Controls  the same code must find a planted momentum and a planted carry
//             effect in seeded data, and nothing in seeded driftless data.
//
// Reported for survivors (descriptive, not tested): the full-sample record, the
// post-2010 record (published work says these effects decayed), the net Sharpe
// and the monthly hit rate with its 95% interval: the honest "probability" a
// user could be shown.
//
// Pure: pinned fixture or seeded inputs only. No DB, no network, no clock.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { controlFdr, stableStringify } from "@workspace/discovery";
import { normalSf } from "@workspace/risk";
import { loadVerifiedSlowFixture, SLOW_CURRENCIES, USD_RATE_SERIES, type Series } from "./slowHistoryFixture.js";

export const SLOW_DIRECTION_VERSION = "arx-slow-direction-research-v1";
export const SPLIT_MONTH = "2000-01";
export const DECAY_MONTH = "2010-01";
export const COST_PER_UNIT = 0.0001;
export const COST_SENSITIVITY = 0.0005;
const Q = 0.05;
const CONFIRM_P = 0.05;
const MOM_LOOKBACKS = [1, 3, 6, 12] as const;
const MAX_RATE_FILL = 3;
const MIN_XS = 6;

/** One currency's monthly panel, aligned to a shared month list. */
export interface CcyMonths {
  ccy: string;
  /** Excess return of holding the currency during month i (from end of i-1 to end of i); NaN if unavailable. */
  x: number[];
  /** i_ccy - i_usd known at the END of month i, percent per year; NaN if unavailable. */
  rateDiff: number[];
}
export interface Panel { months: string[]; ccys: CcyMonths[] }

// ── Building the panel from the fixture ─────────────────────────────────────

const monthOf = (d: string) => d.slice(0, 7);

function monthEndCloses(s: Series, invert: boolean): Map<string, number> {
  const out = new Map<string, number>();
  for (const [d, v] of s) out.set(monthOf(d), invert ? 1 / v : v); // later days overwrite: the month-end fixing
  return out;
}

/** Monthly rate from the first series (priority order) that has the month, forward-filled up to MAX_RATE_FILL months. */
function monthlyRate(months: string[], sources: Series[]): number[] {
  const maps = sources.map((s) => new Map(s.map(([d, v]) => [monthOf(d), v] as const)));
  const out: number[] = [];
  let last = Number.NaN;
  let age = Infinity;
  for (const m of months) {
    const hit = maps.find((mp) => mp.has(m));
    if (hit) { last = hit.get(m)!; age = 0; } else age++;
    out.push(age <= MAX_RATE_FILL ? last : Number.NaN);
  }
  return out;
}

export function buildPanelFromFixture(fixturesRoot = new URL("../../fixtures", import.meta.url).pathname) {
  const { manifest, series } = loadVerifiedSlowFixture(fixturesRoot);
  const months: string[] = [];
  for (let y = 1971; y <= 2026; y++) for (let mo = 1; mo <= 12; mo++) {
    const m = `${y}-${String(mo).padStart(2, "0")}`;
    if (m <= "2026-10") months.push(m);
  }
  const usd = monthlyRate(months, USD_RATE_SERIES.map((id) => series.get(id)!));
  const ccys: CcyMonths[] = SLOW_CURRENCIES.map((c) => {
    const closes = monthEndCloses(series.get(c.fxSeries)!, c.fxInverted);
    const rate = monthlyRate(months, c.rateSeries.map((id) => series.get(id)!));
    const rateDiff = months.map((_, i) => rate[i]! - usd[i]!);
    const x = months.map((m, i) => {
      if (i === 0) return Number.NaN;
      const s0 = closes.get(months[i - 1]!);
      const s1 = closes.get(m);
      const carry = rateDiff[i - 1]!;
      return s0 && s1 && Number.isFinite(carry) ? Math.log(s1 / s0) + carry / 1200 : Number.NaN;
    });
    return { ccy: c.ccy, x, rateDiff };
  });
  return { datasetHash: manifest.datasetHash, panel: { months, ccys } as Panel };
}

// ── Strategies ──────────────────────────────────────────────────────────────

/** Net monthly returns of a strategy, keyed by holding month index. weights[i] = per-ccy weights decided at the end of month i-1. */
function runWeights(panel: Panel, weightsFor: (i: number) => Array<number> | null, cost: number): Array<{ i: number; r: number }> {
  const out: Array<{ i: number; r: number }> = [];
  let prev: number[] = panel.ccys.map(() => 0);
  for (let i = 1; i < panel.months.length; i++) {
    const w = weightsFor(i);
    if (!w) { prev = panel.ccys.map(() => 0); continue; }
    // A weight on a currency whose return this month is unknown is not taken.
    const live = w.map((wi, c) => (wi !== 0 && Number.isFinite(panel.ccys[c]!.x[i]!) ? wi : 0));
    if (live.every((wi) => wi === 0)) { prev = panel.ccys.map(() => 0); continue; }
    let r = 0;
    let turnover = 0;
    // (0 x a missing return is NaN in JS: only held currencies contribute.)
    live.forEach((wi, c) => { if (wi !== 0) r += wi * panel.ccys[c]!.x[i]!; turnover += Math.abs(wi - prev[c]!); });
    out.push({ i, r: r - cost * turnover });
    prev = live;
  }
  return out;
}

/** Summed excess return of months i-k..i-1 (all known at the end of month i-1); NaN if any is missing. */
function pastReturn(c: CcyMonths, i: number, k: number): number {
  if (i - k < 1) return Number.NaN;
  let s = 0;
  for (let j = i - k; j < i; j++) { const v = c.x[j]!; if (!Number.isFinite(v)) return Number.NaN; s += v; }
  return s;
}

type SignalFn = (c: CcyMonths, i: number) => number; // position for holding month i, from data through month i-1
const SIGNALS: Record<string, SignalFn> = {
  ...Object.fromEntries(MOM_LOOKBACKS.map((k) => [`TSMOM_${k}`, (c: CcyMonths, i: number) => { const p = pastReturn(c, i, k); return Number.isFinite(p) && p !== 0 ? Math.sign(p) : Number.NaN; }])),
  CARRY: (c, i) => { const d = c.rateDiff[i - 1]!; return Number.isFinite(d) && d !== 0 ? Math.sign(d) : Number.NaN; },
};

function xsWeights(panel: Panel, i: number, score: (c: CcyMonths) => number): number[] | null {
  const scored = panel.ccys.map((c, k) => ({ k, s: score(c) })).filter((x) => Number.isFinite(x.s) && Number.isFinite(panel.ccys[x.k]!.x[i]!));
  if (scored.length < MIN_XS) return null;
  scored.sort((a, b) => a.s - b.s);
  const third = Math.floor(scored.length / 3);
  const w = panel.ccys.map(() => 0);
  for (const { k } of scored.slice(0, third)) w[k] = -1 / third / 2;
  for (const { k } of scored.slice(-third)) w[k] = 1 / third / 2;
  return w;
}

export interface Hypothesis { key: string; kind: "currency" | "portfolio"; run: (cost: number) => Array<{ i: number; r: number }> }

export function hypotheses(panel: Panel): Hypothesis[] {
  const hs: Hypothesis[] = [];
  for (const [name, sig] of Object.entries(SIGNALS)) {
    panel.ccys.forEach((c, k) => {
      hs.push({ key: `${c.ccy} ${name}`, kind: "currency", run: (cost) => runWeights(panel, (i) => {
        const s = sig(c, i);
        return Number.isFinite(s) ? panel.ccys.map((_, j) => (j === k ? s : 0)) : null;
      }, cost) });
    });
    hs.push({ key: `portfolio ${name}`, kind: "portfolio", run: (cost) => runWeights(panel, (i) => {
      const s = panel.ccys.map((c) => sig(c, i));
      const live = s.filter((v, k) => Number.isFinite(v) && Number.isFinite(panel.ccys[k]!.x[i]!)).length;
      return live ? s.map((v) => (Number.isFinite(v) ? v / live : 0)) : null;
    }, cost) });
  }
  hs.push({ key: "portfolio XS_CARRY", kind: "portfolio", run: (cost) => runWeights(panel, (i) => xsWeights(panel, i, (c) => c.rateDiff[i - 1]!), cost) });
  for (const k of [3, 12]) hs.push({ key: `portfolio XS_MOM_${k}`, kind: "portfolio", run: (cost) => runWeights(panel, (i) => xsWeights(panel, i, (c) => pastReturn(c, i, k)), cost) });
  return hs;
}

// ── Statistics ──────────────────────────────────────────────────────────────

export interface Stat { n: number; meanBpPerMonth: number; t: number; p: number; sharpe: number; hitRate: number; hitLo: number; hitHi: number }
export function stat(rs: readonly number[]): Stat {
  const n = rs.length;
  if (n < 3) return { n, meanBpPerMonth: 0, t: 0, p: 1, sharpe: 0, hitRate: 0, hitLo: 0, hitHi: 0 };
  const mean = rs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  const hits = rs.filter((r) => r > 0).length / n;
  const se = Math.sqrt((hits * (1 - hits)) / n);
  return { n, meanBpPerMonth: mean * 1e4, t, p: Math.min(1, 2 * normalSf(Math.abs(t))), sharpe: sd > 0 ? (mean / sd) * Math.sqrt(12) : 0, hitRate: hits, hitLo: hits - 1.96 * se, hitHi: hits + 1.96 * se };
}

export interface Row {
  key: string; kind: string;
  discovery: Stat; fdrRejected: boolean; confirmation: Stat; survives: boolean;
  full: Stat; post2010: Stat; fullHighCost: Stat;
}

export function runOnPanel(panel: Panel) {
  const hs = hypotheses(panel);
  const split = panel.months.indexOf(SPLIT_MONTH);
  const decay = panel.months.indexOf(DECAY_MONTH);
  const pre = hs.map((h) => {
    const net = h.run(COST_PER_UNIT);
    const hi = h.run(COST_SENSITIVITY);
    return {
      h,
      d: stat(net.filter((x) => x.i < split).map((x) => x.r)),
      c: stat(net.filter((x) => x.i >= split).map((x) => x.r)),
      f: stat(net.map((x) => x.r)),
      post: stat(net.filter((x) => x.i >= decay).map((x) => x.r)),
      hi: stat(hi.map((x) => x.r)),
    };
  });
  const fdr = controlFdr(pre.map((x) => ({ key: x.h.key, p: x.d.p })), Q, hs.length);
  const rejected = new Set(fdr.decisions.filter((d) => d.rejected).map((d) => d.key));
  const rows: Row[] = pre.map(({ h, d, c, f, post, hi }) => {
    const fdrRejected = rejected.has(h.key);
    const survives = fdrRejected && Math.sign(c.meanBpPerMonth) === Math.sign(d.meanBpPerMonth) && c.p < CONFIRM_P;
    return { key: h.key, kind: h.kind, discovery: d, fdrRejected, confirmation: c, survives, full: f, post2010: post, fullHighCost: hi };
  });
  return { family: hs.length, discoveries: rows.filter((r) => r.fdrRejected).length, survivors: rows.filter((r) => r.survives).length, rows };
}

export function runSlowDirectionResearch(fixturesRoot?: string) {
  const { datasetHash, panel } = buildPanelFromFixture(fixturesRoot);
  const r = runOnPanel(panel);
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  const resultHash = createHash("sha256").update(stableStringify(r.rows.map((x) => [
    x.key, x.discovery.n, round(x.discovery.p), x.fdrRejected, x.confirmation.n, round(x.confirmation.p), x.survives, round(x.full.meanBpPerMonth), round(x.post2010.meanBpPerMonth),
  ]))).digest("hex");
  const coverage = panel.ccys.map((c) => {
    const ok = c.x.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
    return { ccy: c.ccy, months: ok.length, first: panel.months[ok[0]!]!, last: panel.months[ok[ok.length - 1]!]! };
  });
  return { version: SLOW_DIRECTION_VERSION, datasetHash, coverage, ...r, resultHash };
}

// ── Seeded controls ─────────────────────────────────────────────────────────

/**
 * A seeded 9-currency panel, 660 months. Monthly FX log returns have 2.5% sd
 * plus, optionally, a planted momentum term (phi x last month's return) and a
 * planted carry term (beta x the rate differential / 1200 added to the FX move).
 */
export function seededPanel(seed: number, opts: { phi?: number; carryBeta?: number } = {}): Panel {
  let s = seed >>> 0 || 1;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const months: string[] = [];
  for (let i = 0; i < 660; i++) months.push(`${1971 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`);
  const ccys: CcyMonths[] = [];
  for (let k = 0; k < 9; k++) {
    const rateDiff: number[] = [];
    let d = (k - 4) * 1.2;
    for (let i = 0; i < months.length; i++) { d = 0.97 * d + 0.03 * (k - 4) * 1.2 + gauss() * 0.4; rateDiff.push(d); }
    const x: number[] = [Number.NaN];
    let prevFx = 0;
    for (let i = 1; i < months.length; i++) {
      const fx = (opts.phi ?? 0) * prevFx + gauss() * 0.025 + ((opts.carryBeta ?? 0) * rateDiff[i - 1]!) / 1200;
      x.push(fx); // the carry accrual is omitted: the planted term IS the carry effect
      prevFx = fx;
    }
    ccys.push({ ccy: `C${k}`, x, rateDiff });
  }
  return { months, ccys };
}

// ── Report ──────────────────────────────────────────────────────────────────

const fmtP = (p: number) => (p < 1e-4 ? p.toExponential(1) : p.toFixed(4));
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function renderSlowDirectionMarkdown(r: ReturnType<typeof runSlowDirectionResearch>): string {
  const L: string[] = [];
  L.push("# Slow-horizon direction: momentum and carry on 55 years of FX", "");
  L.push(`Generated by \`scripts/src/research/slowDirectionResearch.ts\` (${r.version}) on the pinned fixture \`slow-history-v1\` (dataset ${r.datasetHash.slice(0, 12)}…). Result hash ${r.resultHash.slice(0, 12)}…`, "");
  L.push(`Pre-registered family of ${r.family} hypotheses (see the file header). Discovery: holding months before ${SPLIT_MONTH}. Confirmation: ${SPLIT_MONTH} onward. Net of ${COST_PER_UNIT * 1e4} bp per unit traded. **${r.discoveries} discoveries, ${r.survivors} survive confirmation.**`, "");
  L.push("## Coverage", "");
  L.push("| Currency | Months with a return | First | Last |");
  L.push("|---|---:|---|---|");
  for (const c of r.coverage) L.push(`| ${c.ccy} | ${c.months} | ${c.first} | ${c.last} |`);
  L.push("");
  L.push("## Every hypothesis", "");
  L.push("Mean is net bp per month. Hit rate is the share of months with a positive net return.", "");
  L.push("| Hypothesis | Disc. n | Disc. mean | Disc. p | FDR | Conf. n | Conf. mean | Conf. p | Survives | Post-2010 mean | Post-2010 p |");
  L.push("|---|---:|---:|---:|---|---:|---:|---:|---|---:|---:|");
  for (const x of r.rows) {
    L.push(`| ${x.key} | ${x.discovery.n} | ${x.discovery.meanBpPerMonth.toFixed(1)} | ${fmtP(x.discovery.p)} | ${x.fdrRejected ? "yes" : "-"} | ${x.confirmation.n} | ${x.confirmation.meanBpPerMonth.toFixed(1)} | ${fmtP(x.confirmation.p)} | ${x.survives ? "**yes**" : "-"} | ${x.post2010.meanBpPerMonth.toFixed(1)} | ${fmtP(x.post2010.p)} |`);
  }
  L.push("");
  const surv = r.rows.filter((x) => x.survives);
  L.push("## Survivors: the honest record", "");
  if (surv.length === 0) L.push("None.", "");
  else {
    L.push("| Hypothesis | Full mean (bp/mo) | Full Sharpe | Full hit rate (95% CI) | Post-2010 mean | Post-2010 Sharpe | Post-2010 hit rate (95% CI) | Full mean at 5 bp cost |");
    L.push("|---|---:|---:|---|---:|---:|---|---:|");
    for (const x of surv) {
      L.push(`| ${x.key} | ${x.full.meanBpPerMonth.toFixed(1)} | ${x.full.sharpe.toFixed(2)} | ${pct(x.full.hitRate)} (${pct(x.full.hitLo)}–${pct(x.full.hitHi)}) | ${x.post2010.meanBpPerMonth.toFixed(1)} | ${x.post2010.sharpe.toFixed(2)} | ${pct(x.post2010.hitRate)} (${pct(x.post2010.hitLo)}–${pct(x.post2010.hitHi)}) | ${x.fullHighCost.meanBpPerMonth.toFixed(1)} |`);
    }
    L.push("");
  }
  return L.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = runSlowDirectionResearch();
  const i = process.argv.indexOf("--markdown");
  if (i > 0) writeFileSync(process.argv[i + 1]!, renderSlowDirectionMarkdown(r) + "\n");
  console.log(JSON.stringify({ version: r.version, resultHash: r.resultHash, family: r.family, discoveries: r.discoveries, survivors: r.survivors, coverage: r.coverage }, null, 2));
  for (const x of r.rows) console.log(`${x.key.padEnd(22)} D n${x.discovery.n} ${x.discovery.meanBpPerMonth.toFixed(1)}bp p${fmtP(x.discovery.p)} ${x.fdrRejected ? "FDR" : "   "} | C n${x.confirmation.n} ${x.confirmation.meanBpPerMonth.toFixed(1)}bp p${fmtP(x.confirmation.p)} ${x.survives ? "SURVIVES" : ""} | post2010 ${x.post2010.meanBpPerMonth.toFixed(1)} p${fmtP(x.post2010.p)} SR ${x.full.sharpe.toFixed(2)}`);
}
