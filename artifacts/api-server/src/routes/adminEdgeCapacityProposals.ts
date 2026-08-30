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

// ── WHY THIS ROUTE IS NOT A PLAIN LOOP ─────────────────────────────────────
//
// The estimator behind a proposal is Monte-Carlo: on the disclosed framing
// (4000 paths × 250 trades) it is ~14 simulation runs and, measured on this
// machine, ~527 ms of UNINTERRUPTIBLE JavaScript per edge. A straight
// `for (const row of rows) buildEdgeCapacityProposal(...)` over MAX_EDGES is
// therefore ~26 s during which this process — the same process that runs the
// kill switch, the heartbeats and broker command dispatch — answers nothing.
//
// It is latent only while every edge returns INSUFFICIENT_EVIDENCE and the
// simulator never runs. It arms itself precisely when the feature starts
// working, on a surface the dashboard auto-loads on mount and after every
// press, with a recheck button an operator can hold down.
//
// Three things keep that from happening, none of which change a number:
//   1. YIELD — the estimator is driven through `buildEdgeCapacityProposalYielding`,
//      which awaits a breath between probes. The longest single stall becomes
//      ONE probe, and stops growing with the fleet. Measured over 10 PROPOSED
//      edges against a 5 ms heartbeat standing in for the kill-switch timers:
//        sync     — worst continuous stall 5269 ms, heartbeat fired 6× in 5.3 s
//        yielding — worst continuous stall   72 ms, heartbeat fired 143×
//      Same numbers out of both; see the equivalence test.
//   2. SINGLE-FLIGHT — a second request arriving while one is computing joins
//      the one in progress instead of starting a second fleet-wide sweep. A
//      mashed button costs one sweep, not one per press.
//   3. A SHORT CACHE — a completed sweep is reused for CACHE_TTL_MS. The
//      response is stamped with the real `gatheredAt` plus `cached` and
//      `ageMs`, so a reused answer never claims to be fresher than it is.
//
// None of this is a substitute for moving the simulator off this process; it
// bounds the stall, it does not remove the work. If the fleet grows past a few
// dozen live-evidenced edges this needs a worker, and that is worth saying out
// loud rather than discovering it from a missed heartbeat.

/** How long a completed sweep may be re-served. Short: the operator is reading
 *  it to decide a press, and a stale proposal is a stale decision input. */
const CACHE_TTL_MS = 30_000;

/** Hand the event loop back. The ONLY thing this route awaits between probes. */
const breathe = (): Promise<void> =>
  new Promise<void>((resolve) => { setImmediate(resolve); });

type ProposalsResponse = Record<string, unknown>;

/** The last completed sweep, and the sweep currently in flight (if any). */
let lastSweep: { at: number; body: ProposalsResponse } | null = null;
let inFlight: Promise<ProposalsResponse> | null = null;

function requireAdmin(req: any, res: any): { id: number; role: string } | null {
  const u = req.authUser;
  if (!u) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
  if (u.role !== "ADMIN" && u.role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" }); return null;
  }
  return { id: u.id, role: u.role };
}

/** Thrown when production_edges itself cannot be read. Never cached: an
 *  unreadable library is a live condition, not a result worth remembering. */
class EdgeLibraryUnavailable extends Error {}

async function sweepProposals(): Promise<ProposalsResponse> {
  const {
    buildEdgeCapacityProposalYielding,
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
    throw new EdgeLibraryUnavailable();
  }

  const gatheredAt = new Date();
  const startedAt = Date.now();
  const items = [];
  for (const row of rows) {
    const evidence = await gatherEdgeCapacityEvidence(row.id, gatheredAt);
    // Yielding, not sync: see the note above MAX_EDGES. Identical output to
    // the sync builder by construction — same evidence review, same seeded
    // probe sequence — pinned by the sync/async equivalence test.
    const proposal = await buildEdgeCapacityProposalYielding(evidence, breathe);
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
    // A breath BETWEEN edges as well as between probes: the per-edge DB reads
    // and the JSON assembly are not free either.
    await breathe();
  }

  const summary = summariseEdgeCapacityFleet(items.map((i) => i.readout));

  return {
    ok: true,
    gatheredAt: gatheredAt.toISOString(),
    computeMs: Date.now() - startedAt,
    count: items.length,
    truncatedAt: rows.length === MAX_EDGES ? MAX_EDGES : null,
    items,
    summary,
    writes: false,
    maxDeployedUsdReason: MAX_DEPLOYED_USD_REASON,
    note: "PROPOSALS ONLY. Nothing on this response has been recorded, and requesting it changes nothing. Recording an estimate is a separate admin press on POST /api/admin/learning/edges/:id/capacity, and the USD ceiling is never proposed — it is the owner's number.",
  };
}

router.get("/admin/learning/edge-capacity/proposals", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;

  const now = Date.now();
  if (lastSweep != null && now - lastSweep.at < CACHE_TTL_MS) {
    // Re-served, and SAID so. `gatheredAt` is the real gather time, never
    // refreshed on the way out — a cached answer that restamped its own clock
    // would be a fabricated freshness claim.
    return res.json({ ...lastSweep.body, cached: true, ageMs: now - lastSweep.at });
  }

  // Single-flight: a burst of presses joins one sweep instead of stacking one
  // fleet-wide simulation per press.
  if (inFlight == null) {
    inFlight = sweepProposals()
      .then((body) => { lastSweep = { at: Date.now(), body }; return body; })
      .finally(() => { inFlight = null; });
  }

  let body: ProposalsResponse;
  try {
    body = await inFlight;
  } catch (e) {
    if (e instanceof EdgeLibraryUnavailable) {
      return res.status(503).json({
        ok: false,
        error: "EDGE_LIBRARY_UNAVAILABLE",
        message: "production_edges could not be read, so neither a proposal nor a gate readout can be produced. This is an unreadable state, NOT an empty one — do not read it as 'no edges'.",
      });
    }
    log.warn({ err: e, admin: admin.id }, "edge_capacity_proposals_sweep_failed");
    return res.status(503).json({
      ok: false,
      error: "PROPOSAL_SWEEP_FAILED",
      message: "The capacity proposal sweep did not complete, so no proposal and no gate readout can be reported. This is an unreadable state, NOT a state in which every edge is fine.",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
  return res.json({ ...body, cached: false, ageMs: 0 });
});

export default router;
