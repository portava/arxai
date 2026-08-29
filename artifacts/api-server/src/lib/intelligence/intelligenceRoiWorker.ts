// ── #58 Intelligence-ROI Ledger — the complexity governor's missing driver ───
//
// WHY THIS EXISTS: the complexity governor (lib/domain/src/complexity-governor)
// was a pure engine with no runtime caller and no persisted ledger — nothing
// recorded what each intelligent component contributed or cost, so its
// cost-vs-contribution scoring never ran on real data. This worker is the
// missing loop: per pass it aggregates REAL journal/audit evidence (mission
// proposals + CLOSED mission trade drafts + in-process latency samples) into
// per-component ROI records, feeds the EXISTING pure governor, and persists
// both the records and the governor's verdict.
//
// HONESTY CONTRACT (inviolable):
//   * EVIDENCE ONLY. The verdict (including forcedDisableAgentIds and every
//     simplification proposal) is PERSISTED, never acted on: no agent is
//     disabled, merged, or throttled by this worker. Acting on a proposal is
//     an owner decision made against the ledger.
//   * NULL over invention: a component with no closed trades gets NULL pnl
//     fields with a basis string; lossesAvoided is NULL until persisted
//     counterfactual evidence for blocked decisions exists (the do-nothing
//     lab's outcomes are not yet persisted — writing anything else would be a
//     fabricated number in a ledger).
//   * Change-only: a window with zero observed activity writes NOTHING (no
//     empty records, no verdict row); an identical consecutive verdict
//     signature suppresses the duplicate pass row.
//   * FAIL SAFE: a pass error is logged and skipped whole — no partial ledger
//     is left behind mid-aggregation (records + pass row are written in one
//     transaction).
import { and, gte, isNotNull, lt } from "drizzle-orm";
import {
  db,
  missionProposalsTable,
  missionTradeDraftsTable,
  intelligenceRoiRecordsTable,
  intelligenceRoiPassesTable,
} from "@workspace/db";
import {
  runComplexityGovernor,
  type AgentMetrics,
  type AgentTier,
  type ComplexityVerdict,
} from "@workspace/domain/complexity-governor";
import { logger } from "../logger.js";
import { getLatestAaciLatencyRecords } from "../aaci/latencyMonitor.js";

export const INTELLIGENCE_ROI_INTERVAL_MS = 15 * 60 * 1000;
export const INTELLIGENCE_ROI_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Compute/latency budgets fed to the pure governor. Advisory context only —
 *  the verdict is persisted, never enforced. */
export const INTELLIGENCE_ROI_COMPUTE_BUDGET_MS = 5_000;
export const INTELLIGENCE_ROI_CYCLE_LATENCY_BUDGET_MS = 2_000;

/** Mission roles that must never be proposed for disable (the governor
 *  additionally protects ESSENTIAL on its own — this is the mapping). */
const ESSENTIAL_COMPONENT_KEYS = new Set(["RISK", "JUDGE"]);

const DISABLE_VALUES = new Set(["0", "false", "off", "no"]);

/** PURE — is the ROI ledger worker enabled? Absent env = ENABLED. */
export function intelligenceRoiEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return !DISABLE_VALUES.has(raw.trim().toLowerCase());
}

// ── Pure aggregation (DB-free, unit-tested) ─────────────────────────────────

export interface ProposalObservation {
  agentKey: string;
  status: string;
  symbol: string;
  direction: string;
  timeframe: string;
}

export interface ClosedDraftObservation {
  agentKey: string;
  pnl: number | null;
  capturedProfit: number | null;
  missedProfit: number | null;
}

export interface ComponentRoiWindow {
  componentKey: string;
  decisionsObserved: number;
  decisionsContributed: number;  // decisions that became closed trades
  closedTrades: number;
  realizedPnlUsd: number | null;
  capturedProfitUsd: number | null;
  profitsMissedUsd: number | null;
  lossesAvoidedUsd: null;        // no persisted counterfactual evidence yet
  lossesAvoidedBasis: string;
  errorRate01: number;           // vetoed / observed
  fingerprints: string[];
  reasons: string[];
}

function sumOrNull(values: Array<number | null>): number | null {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return null;
  return finite.reduce((a, b) => a + b, 0);
}

/** PURE — fold the window's real observations into per-component ROI. */
export function aggregateComponentWindows(
  proposals: ReadonlyArray<ProposalObservation>,
  closedDrafts: ReadonlyArray<ClosedDraftObservation>,
): ComponentRoiWindow[] {
  const keys = new Set<string>([
    ...proposals.map((p) => p.agentKey),
    ...closedDrafts.map((d) => d.agentKey),
  ]);
  const out: ComponentRoiWindow[] = [];
  for (const key of [...keys].sort()) {
    const mine = proposals.filter((p) => p.agentKey === key);
    const drafts = closedDrafts.filter((d) => d.agentKey === key);
    const vetoed = mine.filter((p) => p.status === "vetoed").length;
    const realized = sumOrNull(drafts.map((d) => d.pnl));
    const reasons: string[] = [];
    if (drafts.length === 0) reasons.push("no closed trades in window — pnl fields are honest nulls");
    out.push({
      componentKey: key,
      decisionsObserved: mine.length,
      decisionsContributed: drafts.length,
      closedTrades: drafts.length,
      realizedPnlUsd: realized,
      capturedProfitUsd: sumOrNull(drafts.map((d) => d.capturedProfit)),
      profitsMissedUsd: sumOrNull(drafts.map((d) => d.missedProfit)),
      lossesAvoidedUsd: null,
      lossesAvoidedBasis:
        "UNKNOWN — no persisted counterfactual evidence for blocked decisions exists yet (do-nothing outcomes are not persisted); recording null, never an invented saving",
      errorRate01: mine.length > 0 ? vetoed / mine.length : 0,
      fingerprints: mine.map((p) => `${p.symbol}:${p.direction}:${p.timeframe}`),
      reasons,
    });
  }
  return out;
}

/** PURE — map ROI windows + latency evidence into the governor's input.
 *  A component with no latency evidence contributes 0 cost with an explicit
 *  reason (never an invented cost), recorded on the persisted row as a NULL
 *  costCpuMs with basis. */
export function toAgentMetrics(
  windows: ReadonlyArray<ComponentRoiWindow>,
  latencyMsByComponent: ReadonlyMap<string, number>,
): AgentMetrics[] {
  return windows.map((w) => {
    const tier: AgentTier = ESSENTIAL_COMPONENT_KEYS.has(w.componentKey) ? "ESSENTIAL" : "OPTIONAL";
    return {
      agentId: w.componentKey,
      tier,
      cpuMsPerCycle: latencyMsByComponent.get(w.componentKey) ?? 0,
      memoryMb: 0,
      uniqueDecisionsContributed: w.decisionsContributed,
      decisionsObserved: w.decisionsObserved,
      errorRate01: Math.min(1, Math.max(0, w.errorRate01)),
      recentOutputFingerprints: w.fingerprints,
    };
  });
}

/** PURE — signature for change-only pass suppression. */
export function verdictSignature(verdict: ComplexityVerdict): string {
  return JSON.stringify({
    forced: [...verdict.forcedDisableAgentIds].sort(),
    proposals: verdict.proposals.map((p) => `${p.action}:${[...p.targetAgentIds].sort().join(",")}`).sort(),
    over: verdict.computeBudget.overBudget,
    degrade: verdict.latencyBudget.recommendDegrade,
    efficiency: verdict.efficiency
      .map((e) => `${e.agentId}:${e.recommendDisable ? 1 : 0}:${e.efficiency01.toFixed(2)}`)
      .sort(),
  });
}

// ── Pass ────────────────────────────────────────────────────────────────────

export interface IntelligenceRoiPassResult {
  examined: number;
  wrote: boolean;
  reason: string;
}

let lastVerdictSignature: string | null = null;

export async function runIntelligenceRoiPass(opts: { nowMs?: number } = {}): Promise<IntelligenceRoiPassResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const windowStart = new Date(nowMs - INTELLIGENCE_ROI_WINDOW_MS);
  const windowEnd = new Date(nowMs);

  const proposalRows = await db
    .select({
      agentKey: missionProposalsTable.agentKey,
      status: missionProposalsTable.status,
      symbol: missionProposalsTable.symbol,
      direction: missionProposalsTable.direction,
      timeframe: missionProposalsTable.timeframe,
    })
    .from(missionProposalsTable)
    .where(and(gte(missionProposalsTable.createdAt, windowStart), lt(missionProposalsTable.createdAt, windowEnd)))
    .limit(5000);

  const draftRows = await db
    .select({
      agentKey: missionTradeDraftsTable.agentKey,
      pnl: missionTradeDraftsTable.pnl,
      capturedProfit: missionTradeDraftsTable.capturedProfit,
      missedProfit: missionTradeDraftsTable.missedProfit,
    })
    .from(missionTradeDraftsTable)
    .where(
      and(
        isNotNull(missionTradeDraftsTable.closedAt),
        gte(missionTradeDraftsTable.closedAt, windowStart),
        lt(missionTradeDraftsTable.closedAt, windowEnd),
      ),
    )
    .limit(5000);

  const windows = aggregateComponentWindows(proposalRows, draftRows);
  if (windows.length === 0) {
    // Change-only: an empty window writes nothing.
    return { examined: 0, wrote: false, reason: "no component activity in window" };
  }

  // Real in-process latency samples (may be empty — honest empty, no invented
  // cycle latencies). Benchmarks are not per-component, so per-component cost
  // stays NULL-with-basis unless a benchmark is literally named after one.
  const latencyRecords = getLatestAaciLatencyRecords();
  const latencyByComponent = new Map<string, number>();
  for (const rec of latencyRecords) {
    if (windows.some((w) => w.componentKey === rec.benchmark)) {
      latencyByComponent.set(rec.benchmark, rec.latencyMs);
    }
  }

  const verdict = runComplexityGovernor({
    agents: toAgentMetrics(windows, latencyByComponent),
    totalComputeBudgetMs: INTELLIGENCE_ROI_COMPUTE_BUDGET_MS,
    cycleLatenciesMs: latencyRecords.map((r) => r.latencyMs),
    cycleLatencyBudgetMs: INTELLIGENCE_ROI_CYCLE_LATENCY_BUDGET_MS,
    generatedAtIso: windowEnd.toISOString(),
  });

  const signature = verdictSignature(verdict);
  const duplicate = signature === lastVerdictSignature;
  lastVerdictSignature = signature;

  // Records + pass row in ONE transaction — no partial ledger on a crash.
  await db.transaction(async (tx) => {
    for (const w of windows) {
      const hasCost = latencyByComponent.has(w.componentKey);
      await tx.insert(intelligenceRoiRecordsTable).values({
        componentKey: w.componentKey,
        windowStart,
        windowEnd,
        decisionsObserved: w.decisionsObserved,
        decisionsContributed: w.decisionsContributed,
        closedTrades: w.closedTrades,
        realizedPnlUsd: w.realizedPnlUsd,
        capturedProfitUsd: w.capturedProfitUsd,
        profitsMissedUsd: w.profitsMissedUsd,
        lossesAvoidedUsd: w.lossesAvoidedUsd,
        lossesAvoidedBasis: w.lossesAvoidedBasis,
        costCpuMs: hasCost ? latencyByComponent.get(w.componentKey)! : null,
        costBasis: hasCost
          ? "latest in-process latency sample for a benchmark named after this component"
          : "UNKNOWN — no latency benchmark maps to this component; null, never an invented cost",
        errorRate01: w.errorRate01,
        reasonsJson: w.reasons,
      });
    }
    if (!duplicate) {
      await tx.insert(intelligenceRoiPassesTable).values({
        ranAt: windowEnd,
        windowStart,
        windowEnd,
        componentsExamined: windows.length,
        verdictJson: verdict,
        reasonsJson: [
          "ADVISORY verdict — persisted only; nothing is auto-disabled, merged, or throttled by this worker",
          ...verdict.reasons,
        ],
      });
    }
  });

  return {
    examined: windows.length,
    wrote: true,
    reason: duplicate ? "records written; duplicate verdict suppressed (change-only)" : "records + verdict written",
  };
}

// ── Worker (missionDriver idiom: unref'd interval, non-overlapping pass) ─────

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startIntelligenceRoiWorker(): void {
  if (timer) return;
  if (!intelligenceRoiEnabled(process.env["ARX_INTELLIGENCE_ROI_ENABLED"])) {
    logger.warn(
      { flag: "ARX_INTELLIGENCE_ROI_ENABLED" },
      "intelligence_roi_DISABLED_by_env — no per-component ROI ledger will be recorded; the complexity governor stays unfed",
    );
    return;
  }
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runIntelligenceRoiPass()
      .then((r) => {
        if (r.wrote) logger.info({ examined: r.examined, reason: r.reason }, "intelligence_roi_pass");
      })
      .catch((err) =>
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "intelligence_roi_pass_failed (fail-safe: nothing written; next tick retries — apply docs/migrations-pending/build-engine-drivers.sql if tables are missing)",
        ),
      )
      .finally(() => { running = false; });
  }, INTELLIGENCE_ROI_INTERVAL_MS).unref();
  logger.info({ intervalMs: INTELLIGENCE_ROI_INTERVAL_MS }, "intelligence_roi_worker_started");
}

export function stopIntelligenceRoiWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
