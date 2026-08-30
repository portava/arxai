// CLI — ingest a daily-close series, guard it, and snapshot it.
//
//   PROBE reachability of every network source (no writes, no snapshot):
//     node --import tsx scripts/src/c8DailySeriesIngest.ts --probe
//
//   FETCH + GUARD + SNAPSHOT:
//     node --import tsx scripts/src/c8DailySeriesIngest.ts \
//       --source stockanalysis --symbol SPY \
//       --from 2004-06-01 --to 2025-12-31 \
//       --at 2026-08-29T00:00:00Z \
//       --out docs/c8-data/SPY.snapshot.json
//
//   IMPORT A FILE THE OWNER DOWNLOADED:
//     node --import tsx scripts/src/c8DailySeriesIngest.ts \
//       --source file --path /abs/path/spy.csv \
//       --adjustment split_dividend_adjusted \
//       --origin-note "downloaded from <vendor> in a browser on <date>" \
//       --symbol SPY --from 2004-06-01 --to 2025-12-31 \
//       --at 2026-08-29T00:00:00Z --out docs/c8-data/SPY.snapshot.json
//
// `--at` is REQUIRED and is written into the provenance: this path never reads
// a clock, so the instant a dataset claims to have been fetched at is always a
// value someone supplied and can be held to.
//
// The snapshot is written only if the integrity guard passes. Exit code is 0
// only on a clean pass.

import { TURN_OF_MONTH_SPEC } from "@workspace/validation";
import type { PriceAdjustment } from "@workspace/markets";
import {
  fileSource,
  ingest,
  networkSource,
  parseArgv,
  requireStr,
  type NetworkSourceName,
} from "./c8DataFeed.js";

const ADJUSTMENTS: readonly PriceAdjustment[] = [
  "split_dividend_adjusted",
  "split_adjusted_only",
  "raw_unadjusted",
  "price_only_index",
  "unknown",
];

/** Symbols probed per source — each source's own mapping decides what it knows. */
const PROBE_PLAN: { source: NetworkSourceName; symbol: string }[] = [
  { source: "fred", symbol: "NDX" },
  { source: "fred", symbol: "SPX" },
  { source: "stockanalysis", symbol: "SPY" },
  { source: "stooq", symbol: "SPY" },
];

async function probe(at: string): Promise<number> {
  console.log("C8 DATA-SOURCE REACHABILITY PROBE");
  console.log(`  at ${at}`);
  console.log(
    "  This measures the network as it is RIGHT NOW from this machine. A blocked host is a finding,\n" +
      "  not a failure to hide, and no bot-detection challenge is worked around.\n",
  );
  let reachable = 0;
  for (const p of PROBE_PLAN) {
    const src = networkSource(p.source);
    const r = await src.fetchDailyCloses(p.symbol, { from: "2024-01-01", to: "2024-03-31" }, at);
    if ("refused" in r) {
      console.log(`  ${p.source.padEnd(14)} ${p.symbol.padEnd(5)} REFUSED ${r.code}`);
      console.log(`  ${"".padEnd(20)} ${r.detail}`);
    } else {
      reachable++;
      const span = r.bars.length > 0 ? `${r.bars[0]!.date}..${r.bars[r.bars.length - 1]!.date}` : "(empty range)";
      console.log(
        `  ${p.source.padEnd(14)} ${p.symbol.padEnd(5)} OK ${String(r.bars.length).padStart(4)} bars ${span}  adjustment=${r.provenance.adjustment} terms=${r.provenance.termsOfUse}`,
      );
    }
  }
  console.log(`\n  ${reachable}/${PROBE_PLAN.length} probes returned bars.`);
  console.log("  file-import is always available and needs no network.");
  return reachable > 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const argv = parseArgv(process.argv.slice(2));
  const at = typeof argv.at === "string" ? argv.at : new Date(0).toISOString();

  if (argv.probe === true) {
    if (typeof argv.at !== "string") {
      console.error("--probe requires --at <iso instant> so the provenance instant is supplied, never read from a clock");
      return 2;
    }
    return probe(at);
  }

  if (typeof argv.at !== "string") {
    console.error(
      "--at <iso instant> is REQUIRED. This path never reads a clock; the fetched-at stamp is always supplied.",
    );
    return 2;
  }

  const sourceName = requireStr(argv, "source");
  const symbol = requireStr(argv, "symbol");
  const from = requireStr(argv, "from");
  const to = requireStr(argv, "to");
  const outPath = typeof argv.out === "string" ? argv.out : undefined;

  let source;
  if (sourceName === "file") {
    const adjustment = requireStr(argv, "adjustment") as PriceAdjustment;
    if (!ADJUSTMENTS.includes(adjustment)) {
      console.error(`--adjustment must be one of: ${ADJUSTMENTS.join(", ")}`);
      return 2;
    }
    source = fileSource({
      path: requireStr(argv, "path"),
      adjustment,
      originNote: requireStr(argv, "origin-note"),
      ...(typeof argv["value-column"] === "string" ? { valueColumn: argv["value-column"] } : {}),
    });
  } else if (sourceName === "fred" || sourceName === "stooq" || sourceName === "stockanalysis") {
    source = networkSource(sourceName);
  } else {
    console.error(`--source must be one of: fred, stooq, stockanalysis, file`);
    return 2;
  }

  const spec = TURN_OF_MONTH_SPEC;
  const outcome = await ingest({
    source,
    symbol,
    range: { from, to },
    at,
    integrity: {
      // Coverage is checked against the PRE-REGISTERED windows, so a series
      // that cannot span the experiment is refused at ingest rather than
      // discovered halfway through an evaluation.
      requiredCoverage: [
        { label: "fitWindow", start: spec.fitWindow.start, end: spec.fitWindow.end },
        { label: "holdoutWindow", start: spec.holdoutWindow.start, end: spec.holdoutWindow.end },
      ],
    },
    ...(outPathOrUndefined(outPath) ?? {}),
  });

  for (const l of outcome.lines) console.log(l);
  if (!outcome.ok) {
    console.log(
      "\nRESULT: the series is NOT usable for C8. Fix the named defects at the source; do not trim, " +
        "interpolate, or relax the guard.",
    );
  }
  return outcome.ok ? 0 : 1;
}

function outPathOrUndefined(p: string | undefined): { outPath: string } | null {
  return p === undefined ? null : { outPath: p };
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    console.error(`c8DailySeriesIngest FAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    process.exitCode = 2;
  });
