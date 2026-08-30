// ═══════════════════════════════════════════════════════════════════════════
// Admin → Edge capacity PROPOSALS + gate #23 readout.  READ-ONLY.
//
// Routes:
//   GET /api/admin/learning/edge-capacity/proposals
//
// Answers two questions the operator currently has no way to ask:
//
//   1. "What WOULD the ruin/capacity simulator say about this edge, on the
//       evidence we actually have?"  →  a PROPOSAL, or an explicit
//       INSUFFICIENT_EVIDENCE with the exact list of what is missing.
//
//   2. "What does gate #23 do to a driver-placed live entry on this edge right
//       now, and why?"  →  a readout produced by calling the REAL gate.
//
// ── THE PRESS BOUNDARY ─────────────────────────────────────────────────────
// This router NEVER writes. It contains no db.insert / db.update / db.delete,
// and the QA lane pins that. A proposal is not a pending write: recording an
// estimate is a separate, explicit admin press on POST
// /api/admin/learning/edges/:id/capacity, and the number that press records is
// authored by the admin, not adopted from here automatically.
//
// It also never reads the promotion ladder. Capacity and promotion are
// different gates; a capacity surface that displayed liveAllowed would invite
// exactly the conflation gate #23 exists to prevent.
// ═══════════════════════════════════════════════════════════════════════════

import { Router } from "express";
import { db } from "@workspace/db";
import { productionEdgesTable } from "@workspace/db/schema";
import { desc } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { logger } from "../lib/logger.js";
import {
  gatherEdgeCapacityEvidence,
  readEdgeDeployedUsd,
} from "../lib/learning/edgeCapacityEvidence.js";

const log = logger.child({ component: "edgeCapacityProposals" });
const router = Router();

/** How many edges one request will simulate over. The estimator runs a seeded
 *  bisection per edge, so this is bounded work, not an open-ended scan. */
const MAX_EDGES = 50;

function requireAdmin(req: any, res: any): { id: number; role: string } | null {
  const u = req.authUser;
  if (!u) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
  if (u.role !== "ADMIN" && u.role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" }); return null;
  }
  return { id: u.id, role: u.role };
}

router.get("/admin/learning/edge-capacity/proposals", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;

  const {
    buildEdgeCapacityProposal,
    MAX_DEPLOYED_USD_REASON,
  } = await import("@workspace/domain/decision-intelligence");
  const {
    readEdgeCapacityGate,
    summariseEdgeCapacityFleet,
  } = await import("@workspace/domain/safety-contracts");

  let rows: Array<{
    id: number;
    name: string;
    versionTag: string;
    capacityStatus: string | null;
    capacityRiskR: number | null;
    capacityMaxDeployedUsd: number | null;
    capacityDeployCapOverrideUsd: number | null;
    capacityEstimatedAt: Date | null;
    capacityRecordedByAdminId: number | null;
  }>;
  try {
    // Deliberately NOT selecting the promotion ladder: this surface governs
    // capacity only (see the header).
    rows = await db.select({
      id: productionEdgesTable.id,
      name: productionEdgesTable.name,
      versionTag: productionEdgesTable.versionTag,
      capacityStatus: productionEdgesTable.capacityStatus,
      capacityRiskR: productionEdgesTable.capacityRiskR,
      capacityMaxDeployedUsd: productionEdgesTable.capacityMaxDeployedUsd,
      capacityDeployCapOverrideUsd: productionEdgesTable.capacityDeployCapOverrideUsd,
      capacityEstimatedAt: productionEdgesTable.capacityEstimatedAt,
      capacityRecordedByAdminId: productionEdgesTable.capacityRecordedByAdminId,
    }).from(productionEdgesTable)
      .orderBy(desc(productionEdgesTable.createdAt))
      .limit(MAX_EDGES);
  } catch (e) {
    // Honest UNKNOWN rather than a 500 or an empty list that reads as "no
    // edges": production_edges may not be migrated in this environment.
    log.warn({ err: e }, "edge_capacity_proposals_library_unavailable");
    return res.status(503).json({
      ok: false,
      error: "EDGE_LIBRARY_UNAVAILABLE",
      message: "production_edges could not be read, so neither a proposal nor a gate readout can be produced. This is an unreadable state, NOT an empty one — do not read it as 'no edges'.",
    });
  }

  const gatheredAt = new Date();
  const items = [];
  for (const row of rows) {
    const evidence = await gatherEdgeCapacityEvidence(row.id, gatheredAt);
    const proposal = buildEdgeCapacityProposal(evidence);
    const deployed = await readEdgeDeployedUsd(row.id);
    const readout = readEdgeCapacityGate({
      edgeId: row.id,
      capacityStatus: row.capacityStatus,
      capacityMaxDeployedUsd: row.capacityMaxDeployedUsd,
      capacityDeployCapOverrideUsd: row.capacityDeployCapOverrideUsd,
      capacityRecordedByAdminId: row.capacityRecordedByAdminId,
      capacityEstimatedAt: row.capacityEstimatedAt?.toISOString() ?? null,
      deployedUsd: deployed.deployedUsd,
      deployedUsdUnknownReason: deployed.unknownReason,
    });
    items.push({
      edgeId: row.id,
      name: row.name,
      versionTag: row.versionTag,
      recorded: {
        capacityStatus: row.capacityStatus,
        capacityRiskR: row.capacityRiskR,
        capacityMaxDeployedUsd: row.capacityMaxDeployedUsd,
        capacityDeployCapOverrideUsd: row.capacityDeployCapOverrideUsd,
        capacityEstimatedAt: row.capacityEstimatedAt?.toISOString() ?? null,
        capacityRecordedByAdminId: row.capacityRecordedByAdminId,
        adminAuthored: row.capacityRecordedByAdminId != null,
      },
      evidence,
      proposal,
      readout,
    });
  }

  const summary = summariseEdgeCapacityFleet(items.map((i) => i.readout));

  return res.json({
    ok: true,
    gatheredAt: gatheredAt.toISOString(),
    count: items.length,
    truncatedAt: rows.length === MAX_EDGES ? MAX_EDGES : null,
    items,
    summary,
    writes: false,
    maxDeployedUsdReason: MAX_DEPLOYED_USD_REASON,
    note: "PROPOSALS ONLY. Nothing on this response has been recorded, and requesting it changes nothing. Recording an estimate is a separate admin press on POST /api/admin/learning/edges/:id/capacity, and the USD ceiling is never proposed — it is the owner's number.",
  });
});

export default router;
