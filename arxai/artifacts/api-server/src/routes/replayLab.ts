// ═══════════════════════════════════════════════════════════════════════════
// /api/replay/* — Phase 6: Replay Lab + What-If Intelligence.
//
// Strict, advisory only. Replay Lab CANNOT place trades. Every response
// sets canPlaceTrades:false. Every replay vaults the relevant event(s):
//   • REPLAY_EXECUTED, BLOCKED_TRADE_REPLAYED, MISSED_TRADE_REPLAYED,
//     OVERRIDE_REPLAYED, WHATIF_EVALUATED, REPLAY_LESSON_GENERATED.
// ═══════════════════════════════════════════════════════════════════════════

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import {
  ReplaySnapshotSchema, WhatIfScenarioSchema,
  runReplay, runWhatIf, replayBlockedTrade, replayMissedTrade,
  replayOverride, generateLessons,
  replayMarketSnapshot, replayAgents, replayJudge,
  replayExecution, replayTraderDNA, replayGlobalState,
  scoreReplay, playbackCandles,
} from "@workspace/domain/replay-lab";
import { shadowCapture } from "../lib/auditVault";

const router: IRouter = Router();
const SOURCE = "REPLAY_LAB" as never; // VaultSource is permissive at runtime

function fail(res: Response, err: unknown) {
  res.status(400).json({ error: "invalid body", detail: String(err) });
}
function severityFor(score01: number): "INFO"|"WARN"|"DANGER"|"CRITICAL" {
  if (score01 >= 0.75) return "INFO";
  if (score01 >= 0.50) return "WARN";
  if (score01 >= 0.25) return "DANGER";
  return "CRITICAL";
}

// ───────────────────────────────────────────────────────────────────────
// POST /api/replay/scenario — full pipeline replay of a snapshot
// ───────────────────────────────────────────────────────────────────────
const ScenarioBody = z.object({
  snapshot: ReplaySnapshotSchema,
  whatIfs:  z.array(WhatIfScenarioSchema).optional(),
}).strict();

router.post("/replay/scenario", async (req: Request, res: Response) => {
  let body: z.infer<typeof ScenarioBody>;
  try { body = ScenarioBody.parse(req.body); } catch (err) { fail(res, err); return; }

  const report = runReplay({ snapshot: body.snapshot, whatIfs: body.whatIfs });

  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "REPLAY_EXECUTED",
    severity: severityFor(report.result.scores.overall01),
    payload: {
      snapshotId: body.snapshot.snapshotId,
      decisionKind: body.snapshot.decisionKind,
      simulatedOutcome: report.result.simulatedOutcome,
      scores: report.result.scores,
    },
  });

  res.json({
    ok: true, canPlaceTrades: false, mode: "REPLAY_LAB",
    result: report.result,
    market: report.market, agent: report.agent, judge: report.judge,
    execution: report.execution, dna: report.dna, global: report.global,
    blocked: report.blocked, missed: report.missed, override: report.override,
    whatIfs: report.whatIfs, lessons: report.lessons,
  });
});

// ───────────────────────────────────────────────────────────────────────
// POST /api/replay/what-if — run one or more counterfactuals on a snapshot
// ───────────────────────────────────────────────────────────────────────
const WhatIfBody = z.object({
  snapshot:  ReplaySnapshotSchema,
  scenarios: z.array(WhatIfScenarioSchema).min(1),
}).strict();

router.post("/replay/what-if", async (req: Request, res: Response) => {
  let body: z.infer<typeof WhatIfBody>;
  try { body = WhatIfBody.parse(req.body); } catch (err) { fail(res, err); return; }

  const results = body.scenarios.map(s => runWhatIf(body.snapshot, s));

  for (const r of results) {
    await shadowCapture({
      source: SOURCE, systemMode: null, globalState: null,
      eventType: "WHATIF_EVALUATED",
      severity: r.betterForTrader ? "WARN" : "INFO",
      payload: {
        snapshotId: body.snapshot.snapshotId,
        scenario: r.scenario,
        rDelta: r.rDelta,
        originalOutcome: r.originalOutcome,
        counterfactualOutcome: r.counterfactualOutcome,
      },
    });
  }

  res.json({
    ok: true, canPlaceTrades: false, mode: "REPLAY_LAB",
    snapshotId: body.snapshot.snapshotId, results,
  });
});

// ───────────────────────────────────────────────────────────────────────
// POST /api/replay/blocked — was the block correct?
// ───────────────────────────────────────────────────────────────────────
router.post("/replay/blocked", async (req: Request, res: Response) => {
  let snap; try { snap = ReplaySnapshotSchema.parse(req.body?.snapshot); }
  catch (err) { fail(res, err); return; }

  const result = replayBlockedTrade(snap);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "BLOCKED_TRADE_REPLAYED",
    severity: result.blockMissedWin ? "WARN" : "INFO",
    payload: { snapshotId: snap.snapshotId, ...result },
  });
  res.json({ ok: true, canPlaceTrades: false, mode: "REPLAY_LAB",
    snapshotId: snap.snapshotId, ...result });
});

// ───────────────────────────────────────────────────────────────────────
// POST /api/replay/missed — would the missed setup have worked?
// ───────────────────────────────────────────────────────────────────────
router.post("/replay/missed", async (req: Request, res: Response) => {
  let snap; try { snap = ReplaySnapshotSchema.parse(req.body?.snapshot); }
  catch (err) { fail(res, err); return; }

  const result = replayMissedTrade(snap);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "MISSED_TRADE_REPLAYED",
    severity: result.setupWorked ? "WARN" : "INFO",
    payload: { snapshotId: snap.snapshotId, ...result },
  });
  res.json({ ok: true, canPlaceTrades: false, mode: "REPLAY_LAB",
    snapshotId: snap.snapshotId, ...result });
});

// ───────────────────────────────────────────────────────────────────────
// POST /api/replay/override — did the user override help?
// ───────────────────────────────────────────────────────────────────────
router.post("/replay/override", async (req: Request, res: Response) => {
  let snap; try { snap = ReplaySnapshotSchema.parse(req.body?.snapshot); }
  catch (err) { fail(res, err); return; }

  const result = replayOverride(snap);
  await shadowCapture({
    source: SOURCE, systemMode: null, globalState: null,
    eventType: "OVERRIDE_REPLAYED",
    severity: result.overrideHurt ? "DANGER" : result.overrideHelped ? "WARN" : "INFO",
    payload: { snapshotId: snap.snapshotId, ...result },
  });
  res.json({ ok: true, canPlaceTrades: false, mode: "REPLAY_LAB",
    snapshotId: snap.snapshotId, ...result });
});

// ───────────────────────────────────────────────────────────────────────
// POST /api/replay/lessons — generate + vault lessons from a snapshot
// ───────────────────────────────────────────────────────────────────────
router.post("/replay/lessons", async (req: Request, res: Response) => {
  let snap; try { snap = ReplaySnapshotSchema.parse(req.body?.snapshot); }
  catch (err) { fail(res, err); return; }

  const report = runReplay({ snapshot: snap });
  for (const lesson of report.lessons) {
    await shadowCapture({
      source: SOURCE, systemMode: null, globalState: null,
      eventType: "REPLAY_LESSON_GENERATED",
      severity:
        lesson.severity === "HIGH" ? "DANGER"
      : lesson.severity === "MEDIUM" ? "WARN"
      : "INFO",
      payload: {
        snapshotId: snap.snapshotId, lesson,
        scoresOverall01: report.result.scores.overall01,
      },
    });
  }
  res.json({ ok: true, canPlaceTrades: false, mode: "REPLAY_LAB",
    snapshotId: snap.snapshotId,
    lessonCount: report.lessons.length, lessons: report.lessons,
    affects: {
      vault: true,
      agents: Array.from(new Set(report.lessons.flatMap(l => l.affectsAgents))),
      traderDNA: report.lessons.some(l => l.affectsTraderDNA),
      calibration: report.lessons.some(l => l.affectsCalibration),
      validationPipeline: report.lessons.some(l => l.affectsValidationPipeline),
    },
  });
});

// Re-export helpers in case external callers want to inspect
export const _internals = {
  playbackCandles, replayMarketSnapshot, replayAgents, replayJudge,
  replayExecution, replayTraderDNA, replayGlobalState,
  scoreReplay, generateLessons,
};

export default router;
