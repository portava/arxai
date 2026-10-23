// Build JJ — Strategy Lab. REPLAY_ONLY experiments across scenarios.
import { randomUUID } from "node:crypto";
import { db, strategyLabExperimentsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { getScenario } from "./scenarios.js";
import { runReplay, generateReplayReport, type RunSettings } from "./engine.js";

export interface ExperimentInput {
  title: string;
  symbol?: string;
  timeframe?: string;
  playbookEntryId?: string;
  scenarioIds: string[];
  settings: RunSettings;
}

export async function createExperiment(input: ExperimentInput) {
  const experimentId = `exp_${randomUUID()}`;
  await db.insert(strategyLabExperimentsTable).values({
    experimentId, title: input.title,
    symbol: input.symbol ?? "", timeframe: input.timeframe ?? "M5",
    playbookEntryId: input.playbookEntryId ?? "",
    scenarioIds: input.scenarioIds, settings: input.settings ?? {},
    resultSummary: {}, status: "PENDING",
  });
  return experimentId;
}

export async function listExperiments(limit = 20) {
  return db.select().from(strategyLabExperimentsTable).orderBy(desc(strategyLabExperimentsTable.createdAt)).limit(limit);
}

export async function getExperiment(experimentId: string) {
  const rows = await db.select().from(strategyLabExperimentsTable).where(eq(strategyLabExperimentsTable.experimentId, experimentId)).limit(1);
  return rows[0] ?? null;
}

export async function runExperiment(experimentId: string) {
  const exp = await getExperiment(experimentId);
  if (!exp) throw new Error("experiment not found");
  await db.update(strategyLabExperimentsTable).set({ status: "RUNNING", updatedAt: new Date() }).where(eq(strategyLabExperimentsTable.experimentId, experimentId));
  const scenarioIds = exp.scenarioIds as string[];
  const settings = exp.settings as RunSettings;
  const perScenario: { scenarioId: string; replayRunId: string; trades: number; netPnl: number; winRate: number; profitFactor: number; reportId: string; promote: boolean; review: boolean }[] = [];
  let totalNet = 0; let totalTrades = 0; let totalWins = 0;
  for (const sid of scenarioIds) {
    const scenario = await getScenario(sid);
    if (!scenario) {
      perScenario.push({ scenarioId: sid, replayRunId: "", trades: 0, netPnl: 0, winRate: 0, profitFactor: 0, reportId: "", promote: false, review: false });
      continue;
    }
    const run = await runReplay(scenario, { ...settings, playbookEntryId: exp.playbookEntryId });
    const report = await generateReplayReport(run, scenario);
    perScenario.push({
      scenarioId: sid, replayRunId: run.replayRunId,
      trades: report.total_trades, netPnl: report.net_pnl,
      winRate: report.win_rate, profitFactor: report.profit_factor,
      reportId: report.replay_report_id,
      promote: report.should_promote_to_playbook, review: report.should_mark_for_review,
    });
    totalNet += report.net_pnl; totalTrades += report.total_trades; totalWins += report.wins;
  }
  const aggregateWinRate = totalTrades > 0 ? +((totalWins / totalTrades) * 100).toFixed(2) : 0;
  const ranking = [...perScenario].sort((a, b) => b.netPnl - a.netPnl);
  const recommendations: { type: string; message: string }[] = [];
  if (perScenario.every(p => p.promote)) recommendations.push({ type: "PROMOTE_ALL", message: "Setup promoted across every scenario in this experiment (REPLAY-only evidence)." });
  if (perScenario.every(p => p.review))  recommendations.push({ type: "REVIEW_ALL",  message: "Setup flagged for REVIEW across every scenario." });
  if (ranking[0])                        recommendations.push({ type: "BEST_SCENARIO", message: `Best scenario: ${ranking[0].scenarioId} with net ${ranking[0].netPnl}` });
  if (ranking[ranking.length - 1])       recommendations.push({ type: "WORST_SCENARIO", message: `Worst scenario: ${ranking[ranking.length - 1].scenarioId} with net ${ranking[ranking.length - 1].netPnl}` });

  const summary = {
    scenariosRun: perScenario.length,
    totalTrades, totalNet: +totalNet.toFixed(4), aggregateWinRate,
    perScenario, ranking, recommendations,
    safetyNotes: [
      "REPLAY_ONLY: experiment never placed live trades.",
      "Strategy Lab does not modify Build II playbook entries automatically.",
      "Live trading remains DISABLED.",
    ],
  };
  await db.update(strategyLabExperimentsTable)
    .set({ status: "COMPLETED", resultSummary: summary, updatedAt: new Date() })
    .where(eq(strategyLabExperimentsTable.experimentId, experimentId));
  return summary;
}

export async function compareExperiments(ids: string[]) {
  const out: Array<{ experimentId: string; title: string; status: string; summary: unknown }> = [];
  for (const id of ids) {
    const e = await getExperiment(id);
    if (e) out.push({ experimentId: e.experimentId, title: e.title, status: e.status, summary: e.resultSummary });
  }
  return out;
}
