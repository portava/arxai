// ── Profit Mission Phase 9 — Promotion service (fail-closed) ──────────────────
//
// SAFETY / SCOPE:
//   - COMPOSES the pure guardrail ceiling + promotion gate + drift detector +
//     learning loop with the mission's HONEST evidence (persisted test results,
//     real closed drafts, certificate acceptance, the platform live-gate snapshot).
//   - A promotion decision is ADVISORY for read; applying an automation-level
//     change is FAIL-CLOSED: the new level is written ONLY when every gate required
//     for it passes AND it is within the user's guardrail ceiling. Live-auto levels
//     additionally require explicit user enablement + an accepted certificate + the
//     platform live gates being enabled — none of which this service can fabricate.
//   - This NEVER places a trade or relaxes a live gate. Enabling live auto only
//     flips an opt-in flag; actual live dispatch still flows through the EXISTING
//     instant-trade router → live pipeline → 18-gate dispatch, unchanged.
//   - Per-user / per-mission isolation: mutation loads the row FOR UPDATE scoped by
//     (id, userId); every change is journalled + audited.
import { and, eq } from "drizzle-orm";
import {
  db,
  profitMissionsTable,
  missionTradeDraftsTable,
  missionEventsTable,
  oneClickAuditTable,
} from "@workspace/db";
import {
  evaluateMissionPromotion,
  resolveGuardrailCeiling,
  detectMissionDrift,
  runMissionLearningLoop,
  metaForLevel,
  isMissionAutomationLevel,
  DEFAULT_MISSION_AUTOMATION_LEVEL,
  FIRST_LIVE_AUTO_LEVEL,
  type MissionAutomationLevel,
  type MissionAccountType,
  type PromotionEvidence,
  type PromotionDecision,
  type GuardrailCeiling,
  type DriftSeverity,
  evidenceBasisFor,
  describeEvidenceBasis,
  evaluateLadderEvidenceBar,
  type ClosedTradeRecord,
  type PromotionEvidenceBasis,
  type EvidenceBarVerdict,
} from "@workspace/domain/profit-mission";
import { readSimulatedClosedDrafts } from "./missionSimulatedFills.js";
import { latestMissionTestResults } from "./missionTestingLabService.js";
import { resolveLiveBrokerExecutionEnabledAsync } from "./live/phaseBConfig.js";
import { checkLevelChange } from "@workspace/domain/safety-contracts/authorityGrants";
import { readAuthorityCeiling } from "./authority/authorityService.js";

type MissionRow = typeof profitMissionsTable.$inferSelect;

export interface PromotionContext {
  /** Normalized product role (OWNER/ADMIN/USER/INVESTOR/…). */
  role: string;
  /** True when the user has no proven trading history (stricter ceiling). */
  isNewUser: boolean;
}

export interface MissionPromotionStatus {
  currentLevel: MissionAutomationLevel;
  liveAutoEnabled: boolean;
  certificateAccepted: boolean;
  decision: PromotionDecision;
  guardrail: GuardrailCeiling;
  driftSeverity: DriftSeverity;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function accountTypeFor(mission: MissionRow): MissionAccountType {
  const m = (mission.executionMode || "paper").trim().toLowerCase();
  return m === "live" ? "live" : m === "demo" ? "demo" : "paper";
}

function coerceLevel(n: number): MissionAutomationLevel {
  return isMissionAutomationLevel(n) ? n : DEFAULT_MISSION_AUTOMATION_LEVEL;
}

async function loadOwnedMission(
  exec: typeof db,
  userId: number,
  missionId: number,
): Promise<MissionRow | null> {
  const rows = await exec
    .select()
    .from(profitMissionsTable)
    .where(and(eq(profitMissionsTable.id, missionId), eq(profitMissionsTable.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

interface ClosedDraft {
  pnl: number;
  rMultiple: number | null;
  symbol: string | null;
  agentKey: string | null;
  /**
   * TRUE when this outcome is a MODELLED paper/demo fill (priced from a real
   * quote) rather than broker-reconciled money. The flag rides every record so
   * the evidence basis can be labelled all the way to the promotion decision.
   */
  simulated: boolean;
}

/**
 * The mission's closed-trade evidence. Two kinds, read from two structurally
 * separate column families and NEVER summed into one money figure:
 *   - broker-reconciled money (`pnl` + `closedAt`, `simulated = false`), and
 *   - SIMULATED paper/demo outcomes (`sim_pnl` + `sim_closed_at`).
 *
 * Both are legitimate PERFORMANCE evidence for the promotion checklist — the
 * `demo_performance` gate is literally about demo trading — but the basis is
 * carried through and stated wherever the decision is displayed or journalled,
 * so a simulated record can never be read as broker truth.
 */
async function readClosedDrafts(userId: number, missionId: number): Promise<ClosedDraft[]> {
  const rows = await db
    .select({
      pnl: missionTradeDraftsTable.pnl,
      rMultiple: missionTradeDraftsTable.rMultiple,
      closedAt: missionTradeDraftsTable.closedAt,
      symbol: missionTradeDraftsTable.symbol,
      agentKey: missionTradeDraftsTable.agentKey,
    })
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.missionId, missionId),
        eq(missionTradeDraftsTable.userId, userId),
        eq(missionTradeDraftsTable.status, "executed"),
        eq(missionTradeDraftsTable.simulated, false),
      ),
    );
  const brokerReconciled: ClosedDraft[] = rows
    .filter((r) => r.closedAt != null && r.pnl != null && Number.isFinite(r.pnl))
    .map((r) => ({
      pnl: r.pnl as number,
      rMultiple: r.rMultiple != null && Number.isFinite(r.rMultiple) ? r.rMultiple : null,
      symbol: r.symbol,
      agentKey: r.agentKey,
      simulated: false,
    }));

  const simulated = (await readSimulatedClosedDrafts(userId, missionId)).map((s) => ({
    pnl: s.pnl,
    rMultiple: s.rMultiple,
    symbol: s.symbol,
    agentKey: s.agentKey,
    simulated: true,
  }));

  return [...brokerReconciled, ...simulated];
}

/**
 * Build the honest promotion evidence for a mission. `liveAutoOverride` lets the
 * apply path evaluate the prospective enablement value being requested in the same
 * call (rather than the stale stored flag).
 */
async function buildEvidence(
  userId: number,
  mission: MissionRow,
  ctx: PromotionContext,
  liveAutoOverride?: boolean,
): Promise<{ evidence: PromotionEvidence; guardrail: GuardrailCeiling; driftSeverity: DriftSeverity }> {
  const { backtest, forward } = await latestMissionTestResults(userId, mission.id);
  const closed = await readClosedDrafts(userId, mission.id);

  const records: ClosedTradeRecord[] = closed.map((c) => ({
    agentKey: c.agentKey,
    strategyKey: c.agentKey,
    symbol: c.symbol,
    session: null,
    pattern: null,
    rMultiple: c.rMultiple ?? 0,
    win: c.pnl > 0,
  }));
  const learning = runMissionLearningLoop(records);

  const demoSampleSize = closed.length;
  const demoWins = closed.filter((c) => c.pnl > 0).length;
  const demoWinRate = demoSampleSize > 0 ? demoWins / demoSampleSize : 0;
  // What that sample actually IS. This label rides the decision to every surface.
  const demoEvidenceBasis: PromotionEvidenceBasis = evidenceBasisFor({
    simulatedCount: closed.filter((c) => c.simulated).length,
    brokerReconciledCount: closed.filter((c) => !c.simulated).length,
  });

  const maxDrawdownPct = Math.max(
    backtest?.metrics.maxDrawdownPct ?? 0,
    forward?.metrics.maxDrawdownPct ?? 0,
  );

  // Drift computed live from the same evidence (self-consistent); UNKNOWN when a
  // side is missing — never a fabricated "no drift".
  const driftSeverity: DriftSeverity = backtest && forward
    ? detectMissionDrift({ historical: backtest.metrics, forward: forward.metrics }).severity
    : "UNKNOWN";

  const guardrail = resolveGuardrailCeiling({
    role: ctx.role,
    accountType: accountTypeFor(mission),
    isNewUser: ctx.isNewUser,
  });
  const liveGatesEnabled = await resolveLiveBrokerExecutionEnabledAsync().catch(() => false);

  const promotion = asRecord(mission.promotionJson);
  const riskRuleCompliant = promotion.riskRuleViolation !== true;

  const evidence: PromotionEvidence = {
    backtestSampleSize: backtest?.sampleSize ?? 0,
    backtestPromotionEligible: backtest?.promotionEligible ?? false,
    forwardSampleSize: forward?.sampleSize ?? 0,
    forwardPromotionEligible: forward?.promotionEligible ?? false,
    demoWinRate,
    demoSampleSize,
    demoEvidenceBasis,
    maxDrawdownPct,
    agentReliability: learning.aggregateAgentReliability,
    riskRuleCompliant,
    driftSeverity,
    liveAutoEnabled: liveAutoOverride ?? mission.liveAutoEnabled,
    liveGatesEnabled,
    certificateAccepted: mission.certificateAcceptedAt != null,
    guardrailMaxLevel: guardrail.maxLevel,
  };
  return { evidence, guardrail, driftSeverity };
}

/** Read-only promotion status for a mission at an (optional) target level. */
export async function resolveMissionPromotionStatus(args: {
  userId: number;
  missionId: number;
  targetLevel?: number;
  ctx: PromotionContext;
}): Promise<{ ok: true; status: MissionPromotionStatus } | { ok: false; kind: "not_found" }> {
  const mission = await loadOwnedMission(db, args.userId, args.missionId);
  if (!mission) return { ok: false, kind: "not_found" };

  const { evidence, guardrail, driftSeverity } = await buildEvidence(args.userId, mission, args.ctx);
  const currentLevel = coerceLevel(mission.automationLevel);
  const targetLevel = args.targetLevel != null && isMissionAutomationLevel(args.targetLevel)
    ? args.targetLevel
    : currentLevel;
  const decision = evaluateMissionPromotion(targetLevel, evidence);

  return {
    ok: true,
    status: {
      currentLevel,
      liveAutoEnabled: mission.liveAutoEnabled,
      certificateAccepted: mission.certificateAcceptedAt != null,
      decision,
      guardrail,
      driftSeverity,
    },
  };
}

/**
 * Resolve the ladder's EVIDENCE bar for a mission (the gates that first become
 * mandatory at demo-auto: backtest / forward / demo performance / drawdown /
 * agent reliability / risk rules / drift).
 *
 * This exists to close the demo→live INVERSION. `applyMissionExecutionMode` used
 * to let a mission step onto real money with a certificate and the platform live
 * switch but NO performance evidence at all, while earning any auto level
 * required the full checklist — so the easiest road to real money skipped the
 * ladder entirely. Pointing a mission at real money now clears the same evidence
 * bar the ladder demands.
 *
 * FAIL-CLOSED: an unreadable mission or an evidence read that throws returns
 * `passed: false` with a typed blocker. An unreadable proof is not a proof.
 */
export async function resolveMissionLadderEvidenceBar(args: {
  userId: number;
  missionId: number;
  ctx: PromotionContext;
}): Promise<EvidenceBarVerdict> {
  try {
    const mission = await loadOwnedMission(db, args.userId, args.missionId);
    if (!mission) {
      return {
        passed: false,
        failedGates: ["mission_not_readable"],
        blockers: ["the mission could not be read — evidence fails closed"],
        demoEvidenceBasis: "UNSTATED",
      };
    }
    const { evidence } = await buildEvidence(args.userId, mission, args.ctx);
    return evaluateLadderEvidenceBar(evidence);
  } catch (err) {
    return {
      passed: false,
      failedGates: ["evidence_unreadable"],
      blockers: [
        `the promotion evidence could not be read (${err instanceof Error ? err.message : String(err)}) — the step fails closed`,
      ],
      demoEvidenceBasis: "UNSTATED",
    };
  }
}

export type ApplyAutomationResult =
  | { ok: true; applied: boolean; level: MissionAutomationLevel; liveAutoEnabled: boolean; decision: PromotionDecision }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "invalid_level" }
  | { ok: false; kind: "explicit_enablement_required"; decision: PromotionDecision };

/**
 * Apply an automation-level change. Fail-closed: writes the level ONLY when the
 * promotion gate approves it. Live-auto levels require `enableLiveAuto === true`
 * (explicit opt-in) in addition to all gates. Downgrading below the first live-auto
 * level always disables the live-auto opt-in.
 */
export async function applyMissionAutomationLevel(args: {
  userId: number;
  missionId: number;
  targetLevel: number;
  ctx: PromotionContext;
  enableLiveAuto?: boolean;
  ip?: string | null;
  ua?: string | null;
}): Promise<ApplyAutomationResult> {
  if (!isMissionAutomationLevel(args.targetLevel)) return { ok: false, kind: "invalid_level" };
  const targetLevel = args.targetLevel;
  const meta = metaForLevel(targetLevel);

  return db.transaction(async (tx): Promise<ApplyAutomationResult> => {
    const rows = await tx
      .select()
      .from(profitMissionsTable)
      .where(and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)))
      .for("update")
      .limit(1);
    const mission = rows[0];
    if (!mission) return { ok: false, kind: "not_found" };

    // Prospective live-auto enablement: only live levels may turn it on, and only
    // when the caller explicitly opts in THIS request. Non-live targets never
    // silently keep a live opt-in.
    const requestedLiveAuto = meta.requiresExplicitLiveEnable ? args.enableLiveAuto === true : false;

    if (meta.requiresExplicitLiveEnable && !requestedLiveAuto) {
      // Build a decision for transparency, but refuse — explicit enablement missing.
      const { evidence } = await buildEvidence(args.userId, mission, args.ctx, false);
      const decision = evaluateMissionPromotion(targetLevel, evidence);
      await auditTx(tx, args, "MISSION_AUTOMATION_LEVEL_BLOCKED", {
        targetLevel, reason: "explicit_enablement_required",
      });
      return { ok: false, kind: "explicit_enablement_required", decision };
    }

    const { evidence } = await buildEvidence(args.userId, mission, args.ctx, requestedLiveAuto);
    let decision = evaluateMissionPromotion(targetLevel, evidence);

    // Capability #37 — unified authority read-through (raise side). An INCREASE
    // above the conservative default must be covered by an active, unexpired,
    // owner-pressed grant in the authority ledger (ACCOUNT- or MISSION-scoped).
    // Reductions and within-default changes never consult the ledger. An
    // unreadable ledger fails CLOSED for the increase — an unreadable
    // permission is not a permission — and the refusal is surfaced as its own
    // named gate rather than a silent no.
    const currentLevelForAuthority = coerceLevel(mission.automationLevel);
    if (targetLevel > currentLevelForAuthority && targetLevel > DEFAULT_MISSION_AUTOMATION_LEVEL) {
      const read = await readAuthorityCeiling({
        userId: args.userId,
        kind: "MISSION_AUTOMATION_LEVEL",
        scopeType: "MISSION",
        scopeRef: String(args.missionId),
      });
      const verdict = read.ok
        ? checkLevelChange({ currentLevel: currentLevelForAuthority, targetLevel, ceiling: read.ceiling })
        : null;
      if (verdict == null || !verdict.allowed) {
        const blocker = read.ok
          ? `authority_grant: raising automation to level ${targetLevel} requires an active owner-pressed authority grant (current ceiling ${read.ceiling.ceiling}${read.ceiling.expiresAt ? `, grant expires ${read.ceiling.expiresAt.toISOString()}` : ""})`
          : `authority_grant: the authority ledger could not be read (${read.reason}) — automation increases fail closed`;
        decision = {
          ...decision,
          approved: false,
          failedGates: [...decision.failedGates, "authority_grant"],
          blockers: [...decision.blockers, blocker],
        };
      }
    }

    if (!decision.approved) {
      await auditTx(tx, args, "MISSION_AUTOMATION_LEVEL_BLOCKED", {
        targetLevel, failedGates: decision.failedGates, blockers: decision.blockers,
      });
      return { ok: true, applied: false, level: coerceLevel(mission.automationLevel), liveAutoEnabled: mission.liveAutoEnabled, decision };
    }

    // Approved. Downgrades below the first live-auto level disable the opt-in.
    const liveAutoEnabled = meta.requiresExplicitLiveEnable
      ? requestedLiveAuto
      : (targetLevel < FIRST_LIVE_AUTO_LEVEL ? false : mission.liveAutoEnabled);

    const promotion = asRecord(mission.promotionJson);
    const promotionJson: Record<string, unknown> = {
      ...promotion,
      lastGate: {
        targetLevel,
        approved: true,
        allowedMaxLevel: decision.allowedMaxLevel,
        // The promotion record states what its evidence was. A level earned on
        // modelled paper/demo fills is never recorded as broker-proven.
        demoEvidenceBasis: decision.demoEvidenceBasis,
        evidenceNotes: decision.evidenceNotes,
        evaluatedAt: new Date().toISOString(),
      },
    };

    await tx
      .update(profitMissionsTable)
      .set({ automationLevel: targetLevel, liveAutoEnabled, promotionJson, updatedAt: new Date() })
      .where(and(eq(profitMissionsTable.id, args.missionId), eq(profitMissionsTable.userId, args.userId)));

    await tx.insert(missionEventsTable).values({
      missionId: args.missionId,
      type: "mission_automation_level_change",
      message: `Automation level set to ${targetLevel}${meta.requiresExplicitLiveEnable ? " (live auto opt-in)" : ""}. Evidence: ${describeEvidenceBasis(decision.demoEvidenceBasis)}.`,
      metadataJson: {
        targetLevel,
        liveAutoEnabled,
        demoEvidenceBasis: decision.demoEvidenceBasis,
        evidenceNotes: decision.evidenceNotes,
      },
    });
    await auditTx(tx, args, "MISSION_AUTOMATION_LEVEL_CHANGE", {
      targetLevel,
      liveAutoEnabled,
      demoEvidenceBasis: decision.demoEvidenceBasis,
    });

    return { ok: true, applied: true, level: targetLevel, liveAutoEnabled, decision };
  });
}

async function auditTx(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  args: { userId: number; missionId: number; ip?: string | null; ua?: string | null },
  action: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(oneClickAuditTable).values({
    userId: args.userId,
    action,
    ip: args.ip ?? null,
    userAgent: args.ua ?? null,
    metadata: JSON.stringify({ missionId: args.missionId, ...metadata }),
  });
}
