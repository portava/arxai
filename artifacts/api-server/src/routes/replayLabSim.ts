// ═══════════════════════════════════════════════════════════════════════════
// /api/replay/sim/* and /api/replay/analysis/* — Phase 6b:
// Decision Simulation + Counterfactual Intelligence System.
//
// All advisory. canPlaceTrades:false on every response. Cannot place trades.
// Vault events:
//   DECISION_TREE_EXPLORED, ALTERNATE_PATH_EVALUATED, COUNTERFACTUAL_BATCH_RUN,
//   SURVIVAL_REPLAY_SCORED, STRESS_INJECTION_REPLAYED,
//   REPLAY_CLUSTER_FORMED, REPLAY_PATTERN_DETECTED, REPLAY_RISK_HEATMAP_BUILT,
//   LESSON_CONFIDENCE_MEASURED, DECISION_SEQUENCE_SCORED, REGRET_RELIEF_CLASSIFIED.
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  ReplaySnapshotSchema, WhatIfScenarioSchema, TradeOutcomeSchema,
  runReplay,
  exploreDecisionTree, DecisionBranchSchema,
  exploreAlternatePaths,
  runCounterfactualBatch,
  scoreSurvivalReplay, SurvivalReplayInputSchema,
  injectReplayStress, StressInjectionSchema,
  clusterReplayRecords,
  detectReplayPatterns,
  buildReplayRiskHeatmap,
  measureLessonConfidence, LessonConfidenceInputSchema,
  scoreDecisionSequence,  SequenceDecisionSchema,
  classifyRegretRelief,
} from "@workspace/domain/replay-lab";
import { shadowCapture } from "../lib/auditVault";

const router: IRouter = Router();
const SOURCE = "REPLAY_LAB" as never;

function fail(res: Response, err: unknown) {
  res.status(400).json({ error: "invalid body", detail: String(err) });
}
function severityFor(score01: number): "INFO"|"WARN"|"DANGER"|"CRITICAL" {
  if (score01 >= 0.75) return "INFO";
  if (score01 >= 0.50) return "WARN";
  if (score01 >= 0.25) return "DANGER";
  return "CRITICAL";
}
const ADVISORY = { canPlaceTrades: false as const, mode: "REPLAY_LAB" as const };

// ───────────────────────────────────────────────────────────────────────────
// SIMULATION
// ───────────────────────────────────────────────────────────────────────────

// POST /api/replay/sim/decision-tree
const TreeBody = z.object({
  snapshot: ReplaySnapshotSchema,
  branches: z.array(DecisionBranchSchema).min(1),
}).strict();
router.post("/replay/sim/decision-tree", async (req: Request, res: Response) => {
  let body: z.infer<typeof TreeBody>;
  try { body = TreeBody.parse(req.body); } catch (err) { return fail(res, err); }
  const tree = exploreDecisionTree(body.snapshot, body.branches);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DECISION_TREE_EXPLORED",
    severity: "INFO",
    payload: {
      snapshotId: body.snapshot.snapshotId,
      branchCount: tree.branches.length,
      bestBranchName: tree.bestBranchName,
      worstBranchName: tree.worstBranchName,
      branches: tree.branches.map((b: { name: string; rDelta: number; rankByR: number }) =>
        ({ name: b.name, rDelta: b.rDelta, rankByR: b.rankByR })),
    },
  });
  res.json({ ok: true, ...ADVISORY, tree });
});

// POST /api/replay/sim/alternate-paths
const AltBody = z.object({ snapshot: ReplaySnapshotSchema }).strict();
router.post("/replay/sim/alternate-paths", async (req: Request, res: Response) => {
  let body: z.infer<typeof AltBody>;
  try { body = AltBody.parse(req.body); } catch (err) { return fail(res, err); }
  const report = exploreAlternatePaths(body.snapshot);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "ALTERNATE_PATH_EVALUATED",
    severity: report.asIsRank > 1 ? "WARN" : "INFO",
    payload: {
      snapshotId: body.snapshot.snapshotId,
      bestPathName: report.bestPathName, asIsRank: report.asIsRank,
      paths: report.paths.map((p: { name: string; rMultiple: number; rDeltaVsAsIs: number }) =>
        ({ name: p.name, rMultiple: p.rMultiple, rDeltaVsAsIs: p.rDeltaVsAsIs })),
    },
  });
  res.json({ ok: true, ...ADVISORY, report });
});

// POST /api/replay/sim/counterfactual-batch
const CFBody = z.object({
  snapshot: ReplaySnapshotSchema,
  scenarios: z.array(WhatIfScenarioSchema).min(1),
}).strict();
router.post("/replay/sim/counterfactual-batch", async (req: Request, res: Response) => {
  let body: z.infer<typeof CFBody>;
  try { body = CFBody.parse(req.body); } catch (err) { return fail(res, err); }
  const report = runCounterfactualBatch(body.snapshot, body.scenarios);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "COUNTERFACTUAL_BATCH_RUN",
    severity: report.improvedFraction01 >= 0.5 ? "WARN" : "INFO",
    payload: {
      snapshotId: report.snapshotId,
      scenarioCount: report.scenarioCount,
      improvedFraction01: report.improvedFraction01,
      meanRDelta: report.meanRDelta, medianRDelta: report.medianRDelta,
      bestScenarioKind:  report.bestScenario?.scenario.kind ?? null,
      worstScenarioKind: report.worstScenario?.scenario.kind ?? null,
      byKind: report.byKind,
    },
  });
  res.json({ ok: true, ...ADVISORY, report });
});

// POST /api/replay/sim/survival
router.post("/replay/sim/survival", async (req: Request, res: Response) => {
  let body: z.infer<typeof SurvivalReplayInputSchema>;
  try { body = SurvivalReplayInputSchema.parse(req.body); } catch (err) { return fail(res, err); }
  const report = scoreSurvivalReplay(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "SURVIVAL_REPLAY_SCORED",
    severity:
      report.classification === "RUINED"   ? "CRITICAL"
    : report.classification === "FRAGILE"  ? "DANGER"
    : report.classification === "ACCEPTABLE" ? "WARN"
    : "INFO",
    payload: report as unknown as Record<string, unknown>,
  });
  res.json({ ok: true, ...ADVISORY, report });
});

// POST /api/replay/sim/stress-injection
const StressBody = z.object({
  snapshot: ReplaySnapshotSchema,
  stress:   StressInjectionSchema,
  rerunReplay: z.boolean().default(true),
}).strict();
router.post("/replay/sim/stress-injection", async (req: Request, res: Response) => {
  let body: z.infer<typeof StressBody>;
  try { body = StressBody.parse(req.body); } catch (err) { return fail(res, err); }
  const inj = injectReplayStress(body.snapshot, body.stress);
  const replayed = body.rerunReplay ? runReplay({ snapshot: inj.mutatedSnapshot }) : null;
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "STRESS_INJECTION_REPLAYED",
    severity:
      replayed && replayed.result.simulatedOutcome.rMultiple <= -1.0 ? "DANGER"
    : replayed && replayed.result.simulatedOutcome.rMultiple <  0    ? "WARN"
    : "INFO",
    payload: {
      snapshotId: body.snapshot.snapshotId,
      stressKind: inj.kind, notes: inj.notes,
      simulatedOutcome: replayed?.result.simulatedOutcome ?? null,
      scoresOverall01:  replayed?.result.scores.overall01 ?? null,
    },
  });
  res.json({ ok: true, ...ADVISORY,
    stressKind: inj.kind, notes: inj.notes,
    mutatedSnapshot: inj.mutatedSnapshot,
    replay: replayed?.result ?? null,
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ANALYSIS
// ───────────────────────────────────────────────────────────────────────────

const RecordSchema = z.object({
  snapshot: ReplaySnapshotSchema,
  outcome:  TradeOutcomeSchema,
}).strict();
const RecordsBody = z.object({ records: z.array(RecordSchema).min(1) }).strict();

// POST /api/replay/analysis/cluster
router.post("/replay/analysis/cluster", async (req: Request, res: Response) => {
  let body: z.infer<typeof RecordsBody>;
  try { body = RecordsBody.parse(req.body); } catch (err) { return fail(res, err); }
  const report = clusterReplayRecords(body.records);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "REPLAY_CLUSTER_FORMED", severity: "INFO",
    payload: {
      totalRecords: report.totalRecords,
      clusterCount: report.clusterCount,
      topClusters: report.clusters.slice(0, 5).map(
        (c: { key: string; size: number; meanR: number }) => ({ key: c.key, size: c.size, meanR: c.meanR })),
    },
  });
  res.json({ ok: true, ...ADVISORY, report });
});

// POST /api/replay/analysis/patterns
router.post("/replay/analysis/patterns", async (req: Request, res: Response) => {
  let body: z.infer<typeof RecordsBody>;
  try { body = RecordsBody.parse(req.body); } catch (err) { return fail(res, err); }
  const patterns = detectReplayPatterns(body.records);
  for (const p of patterns) {
    await shadowCapture({
      source: SOURCE, systemMode: null, globalState: null,
      eventType: "REPLAY_PATTERN_DETECTED",
      severity:
        p.severity === "HIGH"   ? "DANGER"
      : p.severity === "MEDIUM" ? "WARN"
      : "INFO",
      payload: { kind: p.kind, evidence: p.evidence, sampleSize: p.sampleSize },
    });
  }
  res.json({ ok: true, ...ADVISORY, patternCount: patterns.length, patterns });
});

// POST /api/replay/analysis/risk-heatmap
router.post("/replay/analysis/risk-heatmap", async (req: Request, res: Response) => {
  let body: z.infer<typeof RecordsBody>;
  try { body = RecordsBody.parse(req.body); } catch (err) { return fail(res, err); }
  const heatmap = buildReplayRiskHeatmap(body.records);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "REPLAY_RISK_HEATMAP_BUILT",
    severity: heatmap.hottest && heatmap.hottest.risk01 >= 0.6 ? "WARN" : "INFO",
    payload: {
      totalRecords: heatmap.totalRecords,
      cellCount: heatmap.cells.length,
      hottest: heatmap.hottest,
      safest:  heatmap.safest,
    },
  });
  res.json({ ok: true, ...ADVISORY, heatmap });
});

// POST /api/replay/analysis/lesson-confidence
router.post("/replay/analysis/lesson-confidence", async (req: Request, res: Response) => {
  let body: z.infer<typeof LessonConfidenceInputSchema>;
  try { body = LessonConfidenceInputSchema.parse(req.body); } catch (err) { return fail(res, err); }
  const report = measureLessonConfidence(body);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "LESSON_CONFIDENCE_MEASURED",
    severity: severityFor(report.confidence01),
    payload: { ...body, ...report },
  });
  res.json({ ok: true, ...ADVISORY, report });
});

// POST /api/replay/analysis/decision-sequence
const SeqBody = z.object({ decisions: z.array(SequenceDecisionSchema) }).strict();
router.post("/replay/analysis/decision-sequence", async (req: Request, res: Response) => {
  let body: z.infer<typeof SeqBody>;
  try { body = SeqBody.parse(req.body); } catch (err) { return fail(res, err); }
  const report = scoreDecisionSequence(body.decisions);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "DECISION_SEQUENCE_SCORED",
    severity:
      report.classification === "BREAKDOWN" ? "DANGER"
    : report.classification === "WEAK"      ? "WARN"
    : "INFO",
    payload: report as unknown as Record<string, unknown>,
  });
  res.json({ ok: true, ...ADVISORY, report });
});

// POST /api/replay/analysis/regret-relief
router.post("/replay/analysis/regret-relief", async (req: Request, res: Response) => {
  let body: z.infer<typeof RecordsBody>;
  try { body = RecordsBody.parse(req.body); } catch (err) { return fail(res, err); }
  const result = classifyRegretRelief(body.records);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "REGRET_RELIEF_CLASSIFIED",
    severity: result.aggregate.regretScore01 > result.aggregate.reliefScore01 ? "WARN" : "INFO",
    payload: result.aggregate as unknown as Record<string, unknown>,
  });
  res.json({ ok: true, ...ADVISORY, ...result });
});

export default router;
