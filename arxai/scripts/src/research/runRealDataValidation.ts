// CLI: run the real-data validation over the pinned fixture or stored candles,
// print the per-family findings, and optionally store the run as hashed
// evidence (validation_evidence_v1).
//
//   pnpm --filter @workspace/scripts run research:real-data-validation               # fixture, print only
//   pnpm --filter @workspace/scripts run research:real-data-validation -- --store    # + store (DATABASE_URL)
//   pnpm --filter @workspace/scripts run research:real-data-validation -- --source db --store
//   … -- --out /path/run.json                                                         # also write the full result
//
// --source db reads market_candles and broker_candles from DATABASE_URL. Deriv
// synthetic indices are EXCLUDED: they are driftless by construction and are
// covered by the V75 killer test; mixing them in would dilute "real" with
// "known-null". Series shorter than --min-bars (default 500) are skipped and
// listed, never padded.
//
// Read-only against market data. Writes only validation_evidence_v1, and only
// with --store. Never places, sizes or promotes anything.

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { stableStringify } from "@workspace/discovery";
import type { Bar } from "@workspace/validation";
import { loadVerifiedFixture } from "./realHistoryFixture.js";
import { runRealDataValidation, type AssetClass, type RealDataRunResult, type RunnerInstrument } from "./realDataValidation.js";
import { isEntrypoint } from "../ci/inProcessAppHarness.js";
import { ValidationEvidenceStore } from "../../../artifacts/api-server/src/lib/research/validationEvidence.js";

/** The dataset hash this code commits to. Changing the fixture means changing this line. */
export const PINNED_FIXTURE_DATASET_HASH = "fa83f149997cb8f96f7adfba349a60d409f689712311d32728755549dbc6d232";
export const FIXTURE_DIR = new URL("../../fixtures/real-history-v1", import.meta.url).pathname;

export function fixtureInstruments(): { datasetHash: string; instruments: RunnerInstrument[] } {
  const { manifest, instruments } = loadVerifiedFixture(FIXTURE_DIR, PINNED_FIXTURE_DATASET_HASH);
  return {
    datasetHash: manifest.datasetHash,
    instruments: instruments.map((i) => ({
      symbol: i.spec.symbol, assetClass: i.spec.assetClass, ohlc: i.spec.ohlc,
      source: `fixture:real-history-v1/${i.spec.file}`, dates: i.dates, bars: i.bars,
    })),
  };
}

const DERIV_SYNTHETIC = /^(R_\d+|1HZ\d+V|BOOM|CRASH|JD\d+|STP|RDBEAR|RDBULL|VOLATILITY|V\d+)/i;
const BARS_PER_YEAR_BY_TF: Record<string, number> = { M1: 362880, M5: 72576, M15: 24192, M30: 12096, H1: 6048, H4: 1512, D1: 252 };

export function inferAssetClass(symbol: string): AssetClass {
  const s = symbol.toUpperCase();
  if (/^(XAU|XAG|XPT|XPD|GOLD|SILVER)/.test(s)) return "metal";
  if (/^(BTC|ETH|SOL|XRP|LTC|ADA|DOGE)/.test(s)) return "crypto";
  if (/^[A-Z]{6}$/.test(s)) return "fx";
  return "index";
}

type QueryPool = { query: <R>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> };

export async function dbInstruments(pool: QueryPool, minBars: number): Promise<{ datasetHash: string; instruments: RunnerInstrument[]; skipped: string[] }> {
  const instruments: RunnerInstrument[] = [];
  const skipped: string[] = [];
  {
    const groups: Array<{ table: string; key: string; where: string; params: unknown[]; label: string; symbol: string; timeframe: string }> = [];
    const mc = await pool.query<{ symbol: string; timeframe: string; source: string; n: string }>(
      "SELECT symbol,timeframe,source,count(*)::text AS n FROM market_candles GROUP BY 1,2,3 ORDER BY 1,2,3");
    for (const g of mc.rows) {
      const label = `db:market_candles/${g.source}/${g.symbol}/${g.timeframe}`;
      if (g.source === "deriv" || DERIV_SYNTHETIC.test(g.symbol)) { skipped.push(`${label} (Deriv synthetic — covered by the V75 null test)`); continue; }
      if (Number(g.n) < minBars) { skipped.push(`${label} (${g.n} bars < ${minBars})`); continue; }
      groups.push({ table: "market_candles", key: "bar_time", where: "symbol=$1 AND timeframe=$2 AND source=$3", params: [g.symbol, g.timeframe, g.source], label, symbol: g.symbol, timeframe: g.timeframe });
    }
    const bc = await pool.query<{ bridge_connection_id: number; symbol: string; timeframe: string; n: string }>(
      `SELECT bridge_connection_id,symbol,timeframe,count(*)::text AS n FROM broker_candles
       WHERE is_closed_bar AND quality_status='accepted' GROUP BY 1,2,3 ORDER BY 1,2,3`);
    for (const g of bc.rows) {
      const label = `db:broker_candles/bridge${g.bridge_connection_id}/${g.symbol}/${g.timeframe}`;
      if (DERIV_SYNTHETIC.test(g.symbol)) { skipped.push(`${label} (Deriv synthetic)`); continue; }
      if (Number(g.n) < minBars) { skipped.push(`${label} (${g.n} bars < ${minBars})`); continue; }
      groups.push({ table: "broker_candles", key: "open_time_utc",
        where: "bridge_connection_id=$1 AND symbol=$2 AND timeframe=$3 AND is_closed_bar AND quality_status='accepted'",
        params: [g.bridge_connection_id, g.symbol, g.timeframe], label, symbol: g.symbol, timeframe: g.timeframe });
    }
    for (const g of groups) {
      const rows = await pool.query<{ t: Date; open: number; high: number; low: number; close: number }>(
        `SELECT ${g.key} AS t,open,high,low,close FROM ${g.table} WHERE ${g.where} ORDER BY ${g.key}`, g.params);
      const bars: Bar[] = [];
      const dates: string[] = [];
      let bad = 0;
      for (const r of rows.rows) {
        const ok = [r.open, r.high, r.low, r.close].every((x) => x > 0) && r.high >= Math.max(r.open, r.close) && r.low <= Math.min(r.open, r.close);
        // Malformed bars are DROPPED and counted, never repaired.
        if (!ok) { bad++; continue; }
        bars.push({ open: r.open, high: r.high, low: r.low, close: r.close });
        dates.push(r.t.toISOString());
      }
      if (bars.length < minBars) { skipped.push(`${g.label} (${bars.length} valid bars after dropping ${bad} malformed)`); continue; }
      instruments.push({ symbol: `${g.symbol}@${g.timeframe}`, assetClass: inferAssetClass(g.symbol), ohlc: "ohlc",
        source: `${g.label}${bad ? ` (${bad} malformed dropped)` : ""}`, dates, bars,
        barsPerYear: BARS_PER_YEAR_BY_TF[g.timeframe.toUpperCase()] });
    }
  }
  const datasetHash = createHash("sha256").update(stableStringify(instruments.map((i) => ({
    symbol: i.symbol, source: i.source, dates: i.dates, bars: i.bars.map((b) => [b.open, b.high, b.low, b.close]) })))).digest("hex");
  return { datasetHash, instruments, skipped };
}

export function gitCommit(): { commit: string; dirty: boolean } {
  const fromEnv = process.env.GITHUB_SHA;
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
    return { commit, dirty };
  } catch {
    if (fromEnv && /^[a-f0-9]{40}$/.test(fromEnv)) return { commit: fromEnv, dirty: false };
    throw new Error("cannot determine the code commit — refusing to store evidence without one");
  }
}

export function formatFindings(r: RealDataRunResult): string {
  const lines: string[] = [];
  lines.push(`dataset ${r.datasetHash.slice(0, 16)}…  params ${r.paramsHash.slice(0, 16)}…  result ${r.resultHash.slice(0, 16)}…`);
  lines.push(`tests m=${r.fdr.familySize}  BH q=${r.fdr.q} rejections=${r.fdr.rejections}  DSR trials charged=${r.checks.dsrTrialsCharged}  run-wide SR sd=${r.checks.dsrTrialSharpeSd}`);
  lines.push(`honesty: cpcv splits ${r.checks.cpcvSplitsChecked} / violations ${r.checks.cpcvViolations}; walk-forward folds ${r.checks.walkForwardFoldsChecked} / violations ${r.checks.walkForwardViolations}; lookahead ${r.checks.lookaheadVariantsChecked} variants / violations ${r.checks.lookaheadViolations.length}`);
  lines.push("");
  lines.push(`${"instrument".padEnd(18)}${"family".padEnd(24)}${"active".padEnd(8)}${"best ann.SR".padStart(12)}${"best DSR".padStart(10)}${"PBO".padStart(7)}${"WF ann.SR".padStart(11)}  surv  note`);
  for (const s of r.summary) {
    const note = s.activeVariants === 0 ? "NOT SEARCHED (never traded)" : s.rangesDerived ? "ranges derived (close-only)" : "";
    lines.push(`${s.symbol.padEnd(18)}${s.familyKey.padEnd(24)}${`${s.activeVariants}/${s.variants}`.padEnd(8)}${s.bestAnnualisedSharpe.toFixed(2).padStart(12)}${s.bestDsr.toFixed(3).padStart(10)}${(Number.isFinite(s.pbo) ? s.pbo.toFixed(2) : "n/a").padStart(7)}${s.walkForwardAnnualisedSharpe.toFixed(2).padStart(11)}  ${String(s.survivors + (s.walkForwardSurvivor ? 1 : 0)).padStart(4)}  ${note}`);
  }
  lines.push("");
  lines.push(r.survivors.length === 0
    ? "SURVIVORS: none. No strategy-family variant or walk-forward selection survived CPCV + DSR + PBO + family-wide FDR."
    : `SURVIVORS (ceiling SHADOW, liveAllowed=false): ${r.survivors.map((s) => `${s.key} ann.SR ${s.annualisedSharpe.toFixed(2)} DSR ${s.dsr.toFixed(3)} p ${s.pValue.toExponential(2)}`).join("; ")}`);
  return lines.join("\n");
}

async function dbPool() {
  if (!process.env.DATABASE_URL) throw new Error("this mode needs DATABASE_URL");
  return (await import("@workspace/db")).pool;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n: string) => args.includes(n);
  const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const source = val("--source") ?? "fixture";
  let datasetHash: string;
  let instruments: RunnerInstrument[];
  let datasetSource: string;
  if (source === "fixture") {
    ({ datasetHash, instruments } = fixtureInstruments());
    datasetSource = "fixture:real-history-v1";
  } else if (source === "db") {
    const loaded = await dbInstruments(await dbPool() as unknown as QueryPool, Number(val("--min-bars") ?? 500));
    for (const s of loaded.skipped) console.log(`skipped: ${s}`);
    if (loaded.instruments.length === 0) {
      console.log("No stored real candle series met the minimum — nothing to validate. (This is reported, not papered over with the fixture.)");
      return;
    }
    ({ datasetHash, instruments } = loaded);
    datasetSource = "db:market_candles+broker_candles";
  } else throw new Error(`unknown --source ${source}`);

  const run = runRealDataValidation({ instruments, datasetHash });
  console.log(formatFindings(run));
  const out = val("--out");
  if (out) writeFileSync(out, `${JSON.stringify(run, null, 1)}\n`);
  if (flag("--store")) {
    const { commit, dirty } = gitCommit();
    const receipt = await new ValidationEvidenceStore(await dbPool()).record({ run, datasetSource, codeCommit: commit, codeDirty: dirty });
    console.log(`stored: ${receipt.disposition} ${receipt.manifest.id} manifest ${receipt.manifestHash} (commit ${commit}${dirty ? ", DIRTY tree" : ""})`);
  }
  if (process.env.DATABASE_URL && (flag("--store") || source === "db")) await (await dbPool()).end();
}

if (isEntrypoint(import.meta.url)) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
