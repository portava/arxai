// Edge Capacity Recording — foundation gate #23 (EDGE_CAPACITY_EXCEEDED).
//
// Routes:
//   POST /api/admin/learning/edges/:id/capacity — record an edge's capacity
//
// Runs the campaign-3 ruin/capacity simulator (estimateStrategyCapacity,
// deterministic, seeded) on ADMIN-SUPPLIED distribution/friction inputs and
// persists the verdict on the production_edges row TOGETHER with the
// admin-pressed cumulative USD deployable ceiling.
//
// WHY A SEPARATE ROUTER (not adminLearningVersions.ts): the promotion-wave
// surface in adminLearningVersions is pinned READ-ONLY for production_edges
// (test:edge-promotion) — no mutating verb may appear there. This router
// writes ONLY the additive capacity_* columns and NEVER touches the promotion
// ladder: status, liveAllowed, adminApproved, shadowValidated, reportHash and
// validationReportJson are out of its reach by construction (pinned by
// test:tenant-capacity-gates).
//
// SAFETY / FLYWHEEL INVARIANT:
// - The simulator NEVER writes the USD ceiling — `maxDeployedUsd` must be
//   pressed explicitly by the admin in the same request, or (when the
//   simulator verdict is not ESTIMATED) is forced to null: a learned output
//   may only cause REFUSAL, never set a size.
// - Recording capacity can only make gate #23 refuse LESS THAN "always"
//   (no estimate = refuse). It cannot loosen any other gate: #23 is AND-ed
//   after every existing cap, and the optional override column only lowers it.

import { Router } from "express";
import { z } from "zod/v4";
import { db } from "@workspace/db";
import { productionEdgesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { logger } from "../lib/logger.js";

const log = logger.child({ component: "edgeCapacity" });
const router = Router();

function requireAdmin(req: any, res: any): { id: number; role: string } | null {
  const u = req.authUser;
  if (!u) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
  if (u.role !== "ADMIN" && u.role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" }); return null;
  }
  return { id: u.id, role: u.role };
}

const EdgeCapacityBody = z.object({
  simulator: z.object({
    winRate01: z.number().min(0).max(1),
    avgWinR: z.number(),
    avgLossR: z.number().negative(),
    pathsToSimulate: z.number().int().positive().max(20000).default(2000),
    horizonTrades: z.number().int().positive().max(5000).default(200),
    ruinThresholdR: z.number().negative().default(-30),
    seed: z.number().int().nonnegative().default(1),
    concurrentPositions: z.number().int().positive().max(50).optional(),
    correlation01: z.number().min(0).max(1).optional(),
    liquidity: z.object({
      fillProbability01: z.number().min(0).max(1),
      partialFillMean01: z.number().min(0).max(1),
      slippageR: z.number().nonnegative(),
    }).strict().optional(),
    brokerFailure: z.object({
      perTradeFailureProb01: z.number().min(0).max(1),
      failureSlipMultiplier: z.number().min(1).max(10),
    }).strict().optional(),
  }).strict(),
  /** The admin-pressed cumulative USD deployable ceiling. Required for gate
   *  #23 to admit anything; honoured ONLY behind an ESTIMATED verdict. */
  maxDeployedUsd: z.number().positive().optional(),
  /** Optional tighten-only override; gate #23 takes min(ceiling, override). */
  deployCapOverrideUsd: z.number().positive().optional(),
}).strict();

router.post("/admin/learning/edges/:id/capacity", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;
  const edgeId = Number(req.params.id);
  if (!Number.isInteger(edgeId) || edgeId <= 0) {
    return res.status(400).json({ ok: false, error: "BAD_EDGE_ID" });
  }
  const parsed = EdgeCapacityBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY", detail: parsed.error.issues });
  }

  const [edge] = await db.select({ id: productionEdgesTable.id })
    .from(productionEdgesTable).where(eq(productionEdgesTable.id, edgeId)).limit(1);
  if (!edge) return res.status(404).json({ ok: false, error: "EDGE_NOT_FOUND" });

  const { estimateStrategyCapacity } = await import("@workspace/domain/decision-intelligence");
  const estimate = estimateStrategyCapacity(parsed.data.simulator);

  // The pressed USD ceiling is honoured ONLY behind an ESTIMATED verdict —
  // a NO_SAFE_CAPACITY / DEGENERATE_INPUT record stores null and gate #23
  // keeps refusing.
  const ceiling = estimate.status === "ESTIMATED"
    ? (parsed.data.maxDeployedUsd ?? null)
    : null;
  const now = new Date();
  // WRITE SCOPE: capacity_* columns ONLY. The promotion ladder (status,
  // liveAllowed, adminApproved, shadowValidated, evidence) is untouchable
  // from this router — pinned by test:tenant-capacity-gates.
  const [updated] = await db.update(productionEdgesTable).set({
    capacityStatus: estimate.status,
    capacityRiskR: estimate.capacityRiskR,
    capacityMaxDeployedUsd: ceiling,
    capacityDeployCapOverrideUsd: parsed.data.deployCapOverrideUsd ?? null,
    capacityEvidenceJson: {
      simulatorInput: parsed.data.simulator,
      probes: estimate.probes,
      reasons: estimate.reasons,
      recordedAt: now.toISOString(),
    } as unknown as Record<string, unknown>,
    capacityEstimatedAt: now,
    capacityRecordedByAdminId: admin.id,
  }).where(eq(productionEdgesTable.id, edgeId)).returning({
    id: productionEdgesTable.id,
    capacityStatus: productionEdgesTable.capacityStatus,
    capacityRiskR: productionEdgesTable.capacityRiskR,
    capacityMaxDeployedUsd: productionEdgesTable.capacityMaxDeployedUsd,
    capacityDeployCapOverrideUsd: productionEdgesTable.capacityDeployCapOverrideUsd,
    capacityEstimatedAt: productionEdgesTable.capacityEstimatedAt,
  });

  log.info({ edgeId, admin: admin.id, capacityStatus: estimate.status, ceiling },
    "edge_capacity_recorded");
  return res.json({
    ok: true,
    edge: updated,
    estimate,
    note: estimate.status === "ESTIMATED"
      ? (ceiling == null
          ? "Simulator found safe capacity but NO USD ceiling was pressed — gate #23 still refuses (an estimate without a pressed ceiling admits nothing)."
          : "Capacity recorded. Gate #23 now admits deployment on this edge up to the pressed ceiling.")
      : "Simulator found no safe capacity — gate #23 keeps refusing capacity-governed LIVE entries on this edge.",
  });
});

export default router;
