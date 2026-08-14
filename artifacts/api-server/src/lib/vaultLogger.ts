// ═══════════════════════════════════════════════════════════════════════════
// Server-side vault logger — adapter that bridges the pure domain
// vaultLogger.engine builders to the Postgres vault_events table.
//
// Every Phase 2 logging category goes through one of these helpers so the
// payload, severity, source, truth domain, and link IDs are consistent and
// queryable. Routes call these directly; the domain builders enforce shape.
// ═══════════════════════════════════════════════════════════════════════════

import { db, vaultEventsTable } from "@workspace/db";
import {
  buildModeChangeEvent,
  buildBlockedTradeEvent,
  buildApprovedTradeEvent,
  buildRejectedTradeEvent,
  buildRiskDecisionEvent,
  buildKillSwitchEngagedEvent,
  buildKillSwitchResetEvent,
  buildRecoveryEvent,
  buildMt5DisconnectEvent,
  buildLatencySpikeEvent,
  buildSpreadChangeEvent,
  buildUserOverrideEvent,
  buildPaperTradeEvent,
  buildSimulatedTradeEvent,
  type VaultEventInput,
  type ModeChangeArgs,
  type BlockedTradeArgs,
  type ApprovedTradeArgs,
  type RejectedTradeArgs,
  type RiskDecisionArgs,
  type KillSwitchEngagedArgs,
  type KillSwitchResetArgs,
  type RecoveryEventArgs,
  type Mt5DisconnectArgs,
  type LatencySpikeArgs,
  type SpreadChangeArgs,
  type UserOverrideArgs,
  type PaperTradeArgs,
  type SimulatedTradeArgs,
} from "@workspace/domain/black-box-vault";
import { shadowCapture } from "./auditVault.js";
import { logger } from "./logger.js";

async function persist(ev: VaultEventInput): Promise<void> {
  await db.insert(vaultEventsTable).values({
    kind: ev.kind,
    severity: ev.severity,
    source: ev.source,
    truthDomain: ev.truthDomain,
    summary: ev.summary,
    payload: ev.payload ?? {},
    reasons: ev.reasons ?? [],
    blockers: ev.blockers ?? [],
    operationalMode: ev.operationalMode ?? null,
    globalState: ev.globalState ?? null,
    symbol: ev.symbol ?? null,
    linkedTradeId: ev.linkedTradeId ?? null,
    linkedSignalId: ev.linkedSignalId ?? null,
    linkedDecisionId: ev.linkedDecisionId ?? null,
    generatedAtIso: ev.generatedAtIso,
  });
  // SHADOW mirror — hard fail-safe: any thrown error is swallowed so trade
  // logging path keeps working even if audit vault is offline.
  try {
    await shadowCapture({
      eventType: ev.kind,
      source: ev.source,
      severity: ev.severity,
      systemMode: ev.operationalMode ?? null,
      globalState: ev.globalState ?? null,
      timestamp: ev.generatedAtIso,
      payload: {
        summary: ev.summary,
        reasons: ev.reasons ?? [],
        blockers: ev.blockers ?? [],
        truthDomain: ev.truthDomain ?? null,
        symbol: ev.symbol ?? null,
        linkedTradeId: ev.linkedTradeId ?? null,
        linkedSignalId: ev.linkedSignalId ?? null,
        linkedDecisionId: ev.linkedDecisionId ?? null,
        ...(ev.payload ?? {}),
      },
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "shadow vault capture threw (swallowed by vaultLogger)");
  }
}

// ── 13 logging entry points (one per spec category) ──────────────────────
export const logModeChange       = (a: ModeChangeArgs)        => persist(buildModeChangeEvent(a));
export const logBlockedTrade     = (a: BlockedTradeArgs)      => persist(buildBlockedTradeEvent(a));
export const logApprovedTrade    = (a: ApprovedTradeArgs)     => persist(buildApprovedTradeEvent(a));
export const logRejectedTrade    = (a: RejectedTradeArgs)     => persist(buildRejectedTradeEvent(a));
export const logRiskDecision     = (a: RiskDecisionArgs)      => persist(buildRiskDecisionEvent(a));
export const logKillSwitchEvent  = (a: KillSwitchEngagedArgs) => persist(buildKillSwitchEngagedEvent(a));
export const logKillSwitchReset  = (a: KillSwitchResetArgs)   => persist(buildKillSwitchResetEvent(a));
export const logRecoveryEvent    = (a: RecoveryEventArgs)     => persist(buildRecoveryEvent(a));
export const logMt5Disconnect    = (a: Mt5DisconnectArgs)     => persist(buildMt5DisconnectEvent(a));
export const logLatencySpike     = (a: LatencySpikeArgs)      => persist(buildLatencySpikeEvent(a));
export const logSpreadChange     = (a: SpreadChangeArgs)      => persist(buildSpreadChangeEvent(a));
export const logUserOverride     = (a: UserOverrideArgs)      => persist(buildUserOverrideEvent(a));
export const logPaperTrade       = (a: PaperTradeArgs)        => persist(buildPaperTradeEvent(a));
export const logSimulatedTrade   = (a: SimulatedTradeArgs)    => persist(buildSimulatedTradeEvent(a));
