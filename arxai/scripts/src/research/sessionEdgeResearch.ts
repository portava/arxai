// Session / time-of-day DIRECTIONAL edge research on REAL markets
// (scripts/fixtures/real-markets-v1, H1 series).
//
// QUESTION: does the clock tell you which WAY price goes? Volatility research
// (volForecastResearch.ts) showed the clock strongly predicts HOW MUCH price
// moves. This asks the harder question, the one a trading rule needs.
//
// HYPOTHESES (fixed before looking; every one is charged to the family):
//   - hour-of-day drift: the return of the H1 bar starting at UTC hour h, on
//     every weekday, for h = 0..23 (24 per market);
//   - session drift: the close-to-close return of four UTC sessions,
//     Asia 00-07, London 07-12, London/NY overlap 12-16, NY late 16-21 (4 per market);
//   - London continuation: sign(Asia return) x London return, the classic
//     "London follows the Asian move" rule (1 per market).
//   One observation per trading day, so samples are close to independent.
//
// REPLICATION DESIGN (the part that makes a finding believable):
//   - DISCOVERY: the first half of the year. One Benjamini-Hochberg pass at
//     q = 0.05 over every hypothesis on every market.
//   - CONFIRMATION: the second half, never looked at during discovery. A
//     discovery survives only if, out of sample, it keeps its SIGN, is
//     significant at p < 0.05 on its own, and its mean beats the round-trip
//     cost of trading it (two half-spreads).
//
// Prints a JSON summary; with --markdown <path> writes the results doc.
// Reads the pinned fixture only. No DB, no network, no clock, no randomness.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { controlFdr, stableStringify } from "@workspace/discovery";
import { normalSf } from "@workspace/risk";
import { loadVerifiedMarketsFixture } from "./marketsHistoryFixture.js";
import { MARKETS_RUNNER_PARAMS } from "./realDataValidation.js";

export const SESSION_RESEARCH_VERSION = "arx-session-edge-research-v1";
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "fixtures");
const Q = 0.05;
const CONFIRM_P = 0.05;
const MIN_DAYS = 60;

export const SESSIONS: ReadonlyArray<{ name: string; from: number; to: number }> = [
  { name: "Asia 00-07", from: 0, to: 7 },
  { name: "London 07-12", from: 7, to: 12 },
  { name: "Overlap 12-16", from: 12, to: 16 },
  { name: "NY late 16-21", from: 16, to: 21 },
];

export interface SessionHypothesisRow {
  key: string;
  symbol: string;
  hypothesis: string;
  /** Discovery half (first half of the year). */
  discovery: { n: number; meanBp: number; t: number; p: number; fdrRejected: boolean };
  /** Confirmation half (second half), only meaningful for discoveries. */
  confirmation: { n: number; meanBp: number; t: number; p: number };
  /** Round-trip cost in bp for trading this hypothesis once per day. */
  costBp: number;
  survives: boolean;
}

function tTest(xs: readonly number[]): { n: number; mean: number; t: number; p: number } {
  const n = xs.length;
  if (n < 2) return { n, mean: 0, t: 0, p: 1 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  if (!(v > 0)) return { n, mean, t: 0, p: 1 };
  const t = mean / Math.sqrt(v / n);
  // Two-sided normal p (n is in the hundreds; the t/normal gap is negligible here).
  return { n, mean, t, p: Math.min(1, 2 * normalSf(Math.abs(t))) };
}

/** Per day (UTC date) -> per UTC hour -> log return of the H1 bar starting at that hour (close_prev -> close, contiguous only). */
function hourlyReturnsByDay(dates: readonly string[], closes: readonly number[]): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (let i = 1; i < dates.length; i++) {
    const t = Date.parse(dates[i]!);
    if (t - Date.parse(dates[i - 1]!) !== 3600_000) continue; // a gap: this bar's return is not one hour's return
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const day = dates[i]!.slice(0, 10);
    const m = out.get(day) ?? new Map<number, number>();
    m.set(d.getUTCHours(), Math.log(closes[i]! / closes[i - 1]!));
    out.set(day, m);
  }
  return out;
}

/** Sum of hourly returns over [from, to) — only when every hour is present (a full session). */
function sessionReturn(hours: Map<number, number>, from: number, to: number): number | null {
  let s = 0;
  for (let h = from; h < to; h++) { const r = hours.get(h); if (r === undefined) return null; s += r; }
  return s;
}

export function runSessionResearch(fixturesRoot: string = FIXTURES, pinned?: string) {
  const { manifest, instruments } = loadVerifiedMarketsFixture(fixturesRoot, pinned);
  const h1 = instruments.filter((i) => i.spec.timeframe === "H1");
  interface Pending { key: string; symbol: string; hypothesis: string; first: number[]; second: number[]; costBp: number; trades: number }
  const pending: Pending[] = [];
  for (const inst of h1) {
    const byDay = hourlyReturnsByDay(inst.dates, inst.bars.map((b) => b.close));
    const days = [...byDay.keys()].sort();
    const split = days[Math.floor(days.length / 2)]!;
    const halfSpread = MARKETS_RUNNER_PARAMS.costPerTurnover[inst.spec.assetClass as "fx" | "metal" | "index"]!;
    const add = (hypothesis: string, sample: (h: Map<number, number>) => number | null, trades: number) => {
      const first: number[] = [];
      const second: number[] = [];
      for (const day of days) {
        const x = sample(byDay.get(day)!);
        if (x === null) continue;
        (day < split ? first : second).push(x);
      }
      // Round trip = enter + exit = 2 half-spreads per trade.
      pending.push({ key: `${inst.spec.symbol}|${hypothesis}`, symbol: inst.spec.symbol, hypothesis, first, second, costBp: trades * 2 * halfSpread * 1e4, trades });
    };
    for (let h = 0; h < 24; h++) add(`hour ${String(h).padStart(2, "0")}:00 UTC drift`, (m) => m.get(h) ?? null, 1);
    for (const s of SESSIONS) add(`${s.name} session drift`, (m) => sessionReturn(m, s.from, s.to), 1);
    add("London continues the Asian move", (m) => {
      const asia = sessionReturn(m, 0, 7);
      const london = sessionReturn(m, 7, 12);
      return asia === null || london === null || asia === 0 ? null : Math.sign(asia) * london;
    }, 1);
  }
  // The family is fixed before any p-value exists: every hypothesis on every market.
  const tested = pending.filter((p) => p.first.length >= MIN_DAYS);
  const untested = pending.filter((p) => p.first.length < MIN_DAYS).map((p) => ({ key: p.key, days: p.first.length }));
  const disc = tested.map((p) => ({ p, d: tTest(p.first), c: tTest(p.second) }));
  const fdr = controlFdr(disc.map((x) => ({ key: x.p.key, p: x.d.p })), Q, pending.length);
  const rejected = new Set(fdr.decisions.filter((d) => d.rejected).map((d) => d.key));
  const rows: SessionHypothesisRow[] = disc.map(({ p, d, c }) => {
    const fdrRejected = rejected.has(p.key);
    const survives = fdrRejected && c.n >= MIN_DAYS && Math.sign(c.mean) === Math.sign(d.mean) && c.p < CONFIRM_P && Math.abs(c.mean) * 1e4 > p.costBp;
    return {
      key: p.key, symbol: p.symbol, hypothesis: p.hypothesis,
      discovery: { n: d.n, meanBp: d.mean * 1e4, t: d.t, p: d.p, fdrRejected },
      confirmation: { n: c.n, meanBp: c.mean * 1e4, t: c.t, p: c.p },
      costBp: p.costBp, survives,
    };
  });
  // Diagnostics that do not depend on the FDR pass: how many hypotheses kept their sign out of sample at all.
  const signKept = rows.filter((r) => r.confirmation.n > 0 && Math.sign(r.confirmation.meanBp) === Math.sign(r.discovery.meanBp)).length;
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  const resultHash = createHash("sha256").update(stableStringify({
    rows: rows.map((r) => [r.key, r.discovery.n, round(r.discovery.p), r.discovery.fdrRejected, r.confirmation.n, round(r.confirmation.p), r.survives]), untested,
  })).digest("hex");
  return {
    version: SESSION_RESEARCH_VERSION, datasetHash: manifest.datasetHash, family: pending.length,
    discoveries: rows.filter((r) => r.discovery.fdrRejected).length, survivors: rows.filter((r) => r.survives).length,
    signKept, rows, untested, resultHash,
  };
}

const fmtP = (p: number) => (p < 1e-4 ? p.toExponential(1) : p.toFixed(4));

export function renderSessionMarkdown(r: ReturnType<typeof runSessionResearch>): string {
  const L: string[] = [];
  L.push("# Session / time-of-day edge results (real markets)", "");
  L.push(`Generated by \`scripts/src/research/sessionEdgeResearch.ts\` (${r.version}) on the pinned fixture \`real-markets-v1\` (dataset ${r.datasetHash.slice(0, 12)}…). Result hash ${r.resultHash.slice(0, 12)}…`, "");
  L.push(`**${r.survivors} of ${r.family}** hypotheses survived: significant after one Benjamini–Hochberg pass at q = ${Q} on the first half of the year, then the same sign, p < ${CONFIRM_P} and larger than the round-trip cost on the unseen second half.`, "");
  L.push(`- Discoveries in the first half (before confirmation): ${r.discoveries}.`);
  L.push(`- Hypotheses whose average kept its sign from the first half to the second: ${r.signKept} of ${r.rows.length} (a coin flip would keep about half).`);
  if (r.untested.length) L.push(`- Not tested (fewer than ${MIN_DAYS} full days in the first half; still counted in the family): ${r.untested.length}.`);
  L.push("");
  const shown = r.rows.filter((x) => x.discovery.fdrRejected || x.survives);
  if (shown.length) {
    L.push("## First-half discoveries and what happened to them", "", "| Market | Hypothesis | 1st half mean (bp) | 1st half p | 2nd half mean (bp) | 2nd half p | Cost (bp) | Survives |", "|---|---|---|---|---|---|---|---|");
    for (const x of shown) L.push(`| ${x.symbol} | ${x.hypothesis} | ${x.discovery.meanBp.toFixed(2)} | ${fmtP(x.discovery.p)} | ${x.confirmation.meanBp.toFixed(2)} | ${fmtP(x.confirmation.p)} | ${x.costBp.toFixed(1)} | ${x.survives ? "yes" : "no"} |`);
    L.push("");
  }
  L.push("## Strongest first-half results per market (whether or not they cleared FDR)", "", "| Market | Hypothesis | 1st half mean (bp) | 1st half p | 2nd half mean (bp) | 2nd half p |", "|---|---|---|---|---|---|");
  for (const sym of [...new Set(r.rows.map((x) => x.symbol))]) {
    const best = r.rows.filter((x) => x.symbol === sym).sort((a, b) => a.discovery.p - b.discovery.p)[0]!;
    L.push(`| ${sym} | ${best.hypothesis} | ${best.discovery.meanBp.toFixed(2)} | ${fmtP(best.discovery.p)} | ${best.confirmation.meanBp.toFixed(2)} | ${fmtP(best.confirmation.p)} |`);
  }
  L.push("");
  return `${L.join("\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = runSessionResearch();
  const i = process.argv.indexOf("--markdown");
  if (i > 0 && process.argv[i + 1]) writeFileSync(process.argv[i + 1]!, renderSessionMarkdown(r));
  console.log(JSON.stringify({ version: r.version, datasetHash: r.datasetHash, family: r.family, discoveries: r.discoveries, survivors: r.survivors, signKept: r.signKept, tested: r.rows.length, resultHash: r.resultHash }, null, 2));
}
