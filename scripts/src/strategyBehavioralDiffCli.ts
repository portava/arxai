// Strategy behavioral diff — lab CLI surface (capability #14).
//
// Runs two strategy versions over the SAME frozen candle recording and
// writes a journaled BehavioralDiffReport: trade frequency, WAIT↔trade
// flips, stops, holding time, drawdown, costs, affected regimes/sessions,
// and the exact changed-decision inventory. Optionally verifies the
// baseline/candidate against their declarative contracts (capability #13)
// and exits non-zero on any contract mismatch.
//
// This is an OFFLINE lab tool. It reads a recording, computes, and writes a
// report. It opens no execution path, changes no authority, promotes
// nothing — a "better" diff is evidence for the owner, never an enable.
//
// Usage:
//   pnpm --filter @workspace/scripts run lab:strategy-diff -- \
//     --dataset <recording.json> --baseline london-breakout \
//     [--candidate <name> | --candidate-module <path-to-module-exporting-strategy>] \
//     [--out <report.json>] [--reports-dir strategy-diff-reports] [--check-contracts]
//
// Recording file shape (JSON):
//   { "datasetId"?: string, "symbol": string, "pipSize": number,
//     "candles": [{ "time": epochMs, "open": n, "high": n, "low": n, "close": n }...],
//     "costModel"?: { "spreadPips": number } | null, "firstFrameIndex"?: number }

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { STRATEGY_BY_NAME, type Strategy } from "@workspace/domain/strategies";
import {
  buildFrozenFrames,
  runBehavioralDiff,
  compileContract,
  CONTRACT_BY_STRATEGY_NAME,
  type BehavioralDiffReport,
  type ReplayEquivalenceReport,
} from "@workspace/domain/strategy-factory";

// Hand-rolled validation — @workspace/scripts deliberately carries no zod
// dependency; errors are typed strings and the CLI refuses malformed input.
interface Recording {
  datasetId?: string;
  symbol: string;
  pipSize: number;
  candles: Array<{ time: number; open: number; high: number; low: number; close: number; volume?: number }>;
  costModel?: { spreadPips: number } | null;
  firstFrameIndex?: number;
}

function validateRecording(x: unknown): { ok: true; rec: Recording } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (typeof x !== "object" || x === null) return { ok: false, errors: ["recording must be a JSON object"] };
  const r = x as Record<string, unknown>;
  if (typeof r.symbol !== "string" || r.symbol.length === 0) errors.push("symbol: non-empty string required");
  if (!isNum(r.pipSize) || (r.pipSize as number) <= 0) errors.push("pipSize: positive number required");
  if (r.datasetId !== undefined && typeof r.datasetId !== "string") errors.push("datasetId: string when present");
  if (r.firstFrameIndex !== undefined && (!isNum(r.firstFrameIndex) || !Number.isInteger(r.firstFrameIndex) || (r.firstFrameIndex as number) < 0)) {
    errors.push("firstFrameIndex: non-negative integer when present");
  }
  if (r.costModel !== undefined && r.costModel !== null) {
    const cm = r.costModel as Record<string, unknown>;
    if (typeof cm !== "object" || !isNum(cm.spreadPips) || (cm.spreadPips as number) < 0) {
      errors.push("costModel: { spreadPips: number ≥ 0 } or null when present");
    }
  }
  if (!Array.isArray(r.candles) || r.candles.length < 2) {
    errors.push("candles: array of ≥2 bars required");
  } else {
    r.candles.forEach((c, i) => {
      const b = c as Record<string, unknown>;
      if (typeof c !== "object" || c === null
        || !isNum(b.time) || !Number.isInteger(b.time)
        || !isNum(b.open) || !isNum(b.high) || !isNum(b.low) || !isNum(b.close)
        || (b.volume !== undefined && !isNum(b.volume))) {
        if (errors.length < 10) errors.push(`candles[${i}]: needs integer time and finite open/high/low/close`);
      }
    });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, rec: x as Recording };
}

interface CliArgs {
  dataset: string;
  baseline: string;
  candidate: string | null;
  candidateModule: string | null;
  out: string | null;
  reportsDir: string;
  checkContracts: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dataset: "", baseline: "", candidate: null, candidateModule: null,
    out: null, reportsDir: "strategy-diff-reports", checkContracts: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--dataset": args.dataset = next(); break;
      case "--baseline": args.baseline = next(); break;
      case "--candidate": args.candidate = next(); break;
      case "--candidate-module": args.candidateModule = next(); break;
      case "--out": args.out = next(); break;
      case "--reports-dir": args.reportsDir = next(); break;
      case "--check-contracts": args.checkContracts = true; break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!args.dataset) throw new Error("--dataset <recording.json> is required");
  if (!args.baseline) throw new Error("--baseline <strategy-name> is required");
  if (args.candidate === null && args.candidateModule === null) {
    throw new Error("one of --candidate <strategy-name> or --candidate-module <path> is required");
  }
  if (args.candidate !== null && args.candidateModule !== null) {
    throw new Error("--candidate and --candidate-module are mutually exclusive");
  }
  return args;
}

function isStrategy(x: unknown): x is Strategy {
  return typeof x === "object" && x !== null
    && typeof (x as Strategy).name === "string"
    && typeof (x as Strategy).version === "string"
    && typeof (x as Strategy).evaluate === "function";
}

async function resolveCandidate(args: CliArgs): Promise<Strategy> {
  if (args.candidate !== null) {
    const s = STRATEGY_BY_NAME[args.candidate];
    if (!s) throw new Error(`Unknown candidate strategy '${args.candidate}'. Known: ${Object.keys(STRATEGY_BY_NAME).join(", ")}`);
    return s;
  }
  const modPath = resolve(args.candidateModule as string);
  const mod: Record<string, unknown> = await import(pathToFileURL(modPath).href);
  const exported = mod.strategy ?? mod.default;
  if (!isStrategy(exported)) {
    throw new Error(`Module ${modPath} does not export a Strategy as 'strategy' (or default). ` +
      "Expected { name, label, version, evaluate }.");
  }
  return exported;
}

function contractCheck(strategy: Strategy, frames: Parameters<ReturnType<typeof compileContract>["replayEquivalence"]>[1]): ReplayEquivalenceReport | { skipped: true; reason: string } {
  const contract = CONTRACT_BY_STRATEGY_NAME[strategy.name];
  if (!contract) return { skipped: true, reason: `NO_CONTRACT_EXTRACTED_FOR ${strategy.name}` };
  if (contract.strategyVersion !== strategy.version) {
    return { skipped: true, reason: `CONTRACT_PINS ${contract.strategyVersion}, strategy is ${strategy.version} — extract a new contract before trusting equivalence` };
  }
  return compileContract(contract).replayEquivalence(strategy, frames);
}

function summarize(report: BehavioralDiffReport): string {
  const fmtR = (v: number | null) => (v === null ? "null (typed reason in report)" : v.toFixed(4));
  return [
    `report        ${report.reportId}`,
    `dataset       ${report.datasetId} (${report.frameCount} frames, hash ${report.datasetHash ?? "n/a"})`,
    `baseline      ${report.baseline.strategyName}@${report.baseline.strategyVersion}: ${report.baseline.signalsEmitted} signals, ${report.baseline.closedTrades} closed, grossPnlR ${report.baseline.grossPnlR.toFixed(4)}, maxDD_R ${report.baseline.maxDrawdownR.toFixed(4)}, costR ${fmtR(report.baseline.totalCostR)}`,
    `candidate     ${report.candidate.strategyName}@${report.candidate.strategyVersion}: ${report.candidate.signalsEmitted} signals, ${report.candidate.closedTrades} closed, grossPnlR ${report.candidate.grossPnlR.toFixed(4)}, maxDD_R ${report.candidate.maxDrawdownR.toFixed(4)}, costR ${fmtR(report.candidate.totalCostR)}`,
    `changed       ${report.changedDecisions.length} decisions (${report.waitToTradeCount} WAIT→trade, ${report.tradeToWaitCount} trade→WAIT, ${report.directionFlipCount} direction flips)`,
    `regimes hit   ${Object.entries(report.affectedRegimes).map(([k, v]) => `${k}:${v}`).join(" ") || "none"}`,
    `sessions hit  ${Object.entries(report.affectedSessions).map(([k, v]) => `${k}:${v}`).join(" ") || "none"}`,
  ].join("\n");
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  const raw = readFileSync(resolve(args.dataset));
  const parsed = validateRecording(JSON.parse(raw.toString("utf8")));
  if (!parsed.ok) {
    console.error(`Recording file failed validation:\n  ${parsed.errors.join("\n  ")}`);
    return 1;
  }
  const rec = parsed.rec;
  const datasetHash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const datasetId = rec.datasetId ?? `recording-${datasetHash}`;

  const baseline = STRATEGY_BY_NAME[args.baseline];
  if (!baseline) {
    console.error(`Unknown baseline strategy '${args.baseline}'. Known: ${Object.keys(STRATEGY_BY_NAME).join(", ")}`);
    return 1;
  }
  const candidate = await resolveCandidate(args);
  if (candidate.name !== baseline.name) {
    console.error(`Baseline (${baseline.name}) and candidate (${candidate.name}) are different strategies, ` +
      "not two versions of one strategy. A cross-strategy diff is not a behavioral diff; refusing.");
    return 1;
  }

  const dataset = buildFrozenFrames(
    {
      datasetId,
      symbol: rec.symbol,
      pipSize: rec.pipSize,
      candles: rec.candles,
      costModel: rec.costModel ?? null,
    },
    { firstFrameIndex: rec.firstFrameIndex ?? 0 },
  );

  const report = runBehavioralDiff(baseline, candidate, dataset, { now: new Date(), datasetHash });

  let contractExit = 0;
  const contractReports: Record<string, ReplayEquivalenceReport | { skipped: true; reason: string }> = {};
  if (args.checkContracts) {
    for (const [label, s] of [["baseline", baseline], ["candidate", candidate]] as const) {
      const r = contractCheck(s, dataset.frames);
      contractReports[label] = r;
      if ("skipped" in r) {
        console.error(`[contract] ${label}: SKIPPED — ${r.reason}`);
      } else if (r.verdict === "MISMATCH") {
        contractExit = 2;
        console.error(`[contract] ${label}: MISMATCH — ${r.mismatches.length} frame(s) disagree (see report)`);
      } else {
        console.log(`[contract] ${label}: EQUIVALENT over ${r.framesEvaluated} frames`);
      }
    }
  }

  const outPath = resolve(args.out ?? join(args.reportsDir, `${report.reportId}.json`));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ report, contractReports }, null, 2));

  const journalPath = resolve(args.reportsDir, "journal.ndjson");
  mkdirSync(dirname(journalPath), { recursive: true });
  appendFileSync(journalPath, JSON.stringify({
    reportId: report.reportId,
    generatedAtIso: report.generatedAtIso,
    datasetId: report.datasetId,
    datasetHash: report.datasetHash,
    baseline: `${report.baseline.strategyName}@${report.baseline.strategyVersion}`,
    candidate: `${report.candidate.strategyName}@${report.candidate.strategyVersion}`,
    changedDecisions: report.changedDecisions.length,
    waitToTrade: report.waitToTradeCount,
    tradeToWait: report.tradeToWaitCount,
    reportPath: outPath,
  }) + "\n");

  console.log(summarize(report));
  console.log(`\nfull report   ${outPath}`);
  console.log(`journal       ${journalPath}`);
  return contractExit;
}

main().then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
