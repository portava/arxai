// Self-Trade AI — Orchestrator (Foundation skeleton + Phase 3 timing handshake).
//
// The orchestrator will, in a LATER phase, turn an agent's funded state +
// settings + market context into trade INTENTS. In this foundation phase it is
// COMPUTE-ONLY and explicitly does NOT place, queue, or dispatch anything. It
// produces a deterministic readiness verdict the control room can show:
// "what would block this agent from trading right now?".
//
// Phase 3 adds a timing handshake check: the timing brain's entry-permission
// and danger signals are evaluated as advisory tags on the readiness result.
// These tags are NEVER a new execution gate — they inform only. The
// EXECUTION_NOT_IMPLEMENTED sentinel still ensures ready=false always.
//
// SAFETY (inviolable): even when execution wiring lands, every intent must still
// pass the existing 16-gate live pipeline, Risk Governor, per-user allocation,
// and kill switches. This module never bypasses any of them — and right now it
// dispatches nothing at all.

import { eq } from "drizzle-orm";
import {
  db,
  selfTradeAgentsTable,
  selfTradeAgentSettingsTable,
  selfTradeAgentLedgerTable,
  selfTradeKillSwitchesTable,
  type SelfTradeAgent,
} from "@workspace/db";
import { computeTimingRead } from "../../brain/timing/marketTimingBrainService.js";

export type ReadinessBlockReason =
  | "AGENT_NOT_ACTIVE"
  | "NO_SETTINGS"
  | "UNFUNDED"
  | "NO_AVAILABLE_FUNDS"
  | "GLOBAL_KILL_ENGAGED"
  | "AGENT_KILL_ENGAGED"
  | "SHADOW_MODE"
  | "AUTONOMY_SUGGEST_ONLY"
  | "EXECUTION_NOT_IMPLEMENTED";

// Advisory timing tags stored on each readiness check — never a gate.
export type TimingPermissionTag =
  | "TIMING_GO"             // Entry permission is GO
  | "TIMING_WAIT_ENTRY"     // Conditions good, wait for pullback
  | "TIMING_WAIT_NEWS"      // News event approaching — hold
  | "TIMING_NO_TRADE"       // Poor edge / danger high
  | "TIMING_STAND_DOWN"     // Extreme danger / session closed
  | "TIMING_DIRTY_HEAT"     // Heat present but disorganised
  | "TIMING_TRAP_RISK"      // High trap probability
  | "TIMING_EXHAUSTED"      // Move appears exhausted
  | "TIMING_BROAD_CONFLICT" // Cross-asset flow opposing
  | "TIMING_NEWS_FIRST_CANDLE" // First candle after news — skip
  | "TIMING_LOW_ROOM"       // Insufficient room to move
  | "TIMING_DATA_UNAVAILABLE"; // Timing read not available (fail-open)

export interface TimingHandshake {
  symbol: string;
  timingGrade: string;
  entryPermission: string;
  bestAction: string;
  actionReason: string;
  heatScore: number;
  tradeabilityScore: number;
  dangerScore: number;
  tags: TimingPermissionTag[];
  advisoryNote: string; // One-sentence plain-English summary for the UI
  dataQualityLabel: string;
}

export interface AgentReadiness {
  agentId: number;
  agentKey: string;
  // Foundation phase: ready is ALWAYS false — execution is not implemented yet.
  ready: false;
  blockReasons: ReadinessBlockReason[];
  // Phase 3: advisory timing handshake (absent when no symbol configured).
  timingHandshake?: TimingHandshake;
}

// Compute a read-only readiness verdict for one agent. No side effects.
export async function computeAgentReadiness(agentId: number): Promise<AgentReadiness | null> {
  const agentRows = await db
    .select()
    .from(selfTradeAgentsTable)
    .where(eq(selfTradeAgentsTable.id, agentId))
    .limit(1);
  const agent = agentRows[0];
  if (!agent) return null;
  return computeReadinessForAgent(agent);
}

export async function computeReadinessForAgent(agent: SelfTradeAgent): Promise<AgentReadiness> {
  const blockReasons: ReadinessBlockReason[] = [];

  if (agent.status !== "ACTIVE") blockReasons.push("AGENT_NOT_ACTIVE");
  if (agent.status === "UNFUNDED") blockReasons.push("UNFUNDED");
  if (agent.mode === "SHADOW") blockReasons.push("SHADOW_MODE");
  if (agent.autonomyLevel < 1) blockReasons.push("AUTONOMY_SUGGEST_ONLY");

  const settings = await db
    .select()
    .from(selfTradeAgentSettingsTable)
    .where(eq(selfTradeAgentSettingsTable.agentId, agent.id))
    .limit(1);
  if (!settings[0]) blockReasons.push("NO_SETTINGS");

  const ledger = await db
    .select()
    .from(selfTradeAgentLedgerTable)
    .where(eq(selfTradeAgentLedgerTable.agentId, agent.id))
    .limit(1);
  if (!ledger[0] || ledger[0].availableFunds <= 0) blockReasons.push("NO_AVAILABLE_FUNDS");

  const kills = await db.select().from(selfTradeKillSwitchesTable);
  const globalKill = kills.find((k) => k.scope === "GLOBAL" && k.engaged);
  if (globalKill) blockReasons.push("GLOBAL_KILL_ENGAGED");
  const agentKill = kills.find(
    (k) => k.scope === "AGENT" && k.scopeRef === agent.agentKey && k.engaged,
  );
  if (agentKill) blockReasons.push("AGENT_KILL_ENGAGED");

  // Foundation phase: execution layer does not exist yet. This sentinel keeps
  // grep/audit honest that no agent can ever be runtime-ready in this phase.
  blockReasons.push("EXECUTION_NOT_IMPLEMENTED");

  // ── Phase 3: Advisory timing handshake ───────────────────────────────────
  // Fail-open: any error leaves timingHandshake absent — agent readiness is
  // unaffected. The timing check is NEVER a block reason or gate.
  const timingHandshake = await computeTimingHandshake(agent).catch(() => undefined);

  return {
    agentId: agent.id,
    agentKey: agent.agentKey,
    ready: false,
    blockReasons,
    timingHandshake,
  };
}

// Advisory timing check for one agent. Reads the configured symbol (or
// falls back to EURUSD). Produces a list of advisory tags and a plain-
// English note. Never blocks the agent — advisory only.
async function computeTimingHandshake(agent: SelfTradeAgent): Promise<TimingHandshake | undefined> {
  const agentSettings = await db
    .select()
    .from(selfTradeAgentSettingsTable)
    .where(eq(selfTradeAgentSettingsTable.agentId, agent.id))
    .limit(1);

  // Pick the first configured symbol or fall back to EURUSD.
  const rawSymbols: string[] = (() => {
    const s = agentSettings[0];
    if (!s) return [];
    // allowedSymbols may be stored as JSON array or comma-separated string.
    if (s.allowedSymbols && typeof s.allowedSymbols === "string") {
      try {
        const parsed = JSON.parse(s.allowedSymbols);
        if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
      } catch {
        return s.allowedSymbols.split(",").map((x) => x.trim()).filter(Boolean);
      }
    }
    if (Array.isArray(s.allowedSymbols)) return s.allowedSymbols.filter((x): x is string => typeof x === "string");
    return [];
  })();

  const symbol = rawSymbols[0] ?? "EURUSD";

  let read;
  try {
    read = await computeTimingRead({ symbol, timeframe: "M15", persistSnapshot: false });
  } catch {
    return {
      symbol,
      timingGrade: "F",
      entryPermission: "NO_TRADE",
      bestAction: "WATCH_ONLY",
      actionReason: "Timing data unavailable.",
      heatScore: 0,
      tradeabilityScore: 0,
      dangerScore: 0,
      tags: ["TIMING_DATA_UNAVAILABLE"],
      advisoryNote: "Timing data unavailable — proceeding with standard checks only.",
      dataQualityLabel: "unavailable",
    };
  }

  const tags: TimingPermissionTag[] = [];

  // Map entry permission to a tag.
  switch (read.entryPermission) {
    case "GO":              tags.push("TIMING_GO"); break;
    case "WAIT_FOR_ENTRY": tags.push("TIMING_WAIT_ENTRY"); break;
    case "WAIT_NEWS":      tags.push("TIMING_WAIT_NEWS"); break;
    case "NO_TRADE":       tags.push("TIMING_NO_TRADE"); break;
    case "STAND_DOWN":     tags.push("TIMING_STAND_DOWN"); break;
  }

  // Additional diagnostic tags.
  if (read.heatState === "DIRTY_HEAT" || read.heatState === "FALSE_HEAT") tags.push("TIMING_DIRTY_HEAT");
  if (read.heatState === "TRAP_HEAT" || read.trapProbability > 65)        tags.push("TIMING_TRAP_RISK");
  if (read.heatState === "EXHAUSTION_HEAT" || read.moveStage === "EXHAUSTED") tags.push("TIMING_EXHAUSTED");
  if (read.broadFlow.verdict === "OPPOSING" || read.broadFlow.verdict === "CONFLICTED") tags.push("TIMING_BROAD_CONFLICT");
  if (read.newsOverlay.phase === "AT_EVENT" || read.newsOverlay.phase === "POST_EVENT") tags.push("TIMING_NEWS_FIRST_CANDLE");
  if (read.roomToMove < 20) tags.push("TIMING_LOW_ROOM");

  // Advisory note — one sentence, user-safe.
  const advisoryNote =
    read.entryPermission === "GO"
      ? `${symbol} looks ${read.timingGrade}-grade — ${read.actionReason}`
      : read.entryPermission === "STAND_DOWN"
        ? `${symbol}: ${read.actionReason} Wait for conditions to improve.`
        : `${symbol} timing is ${read.timingGrade}-grade — ${read.actionReason}`;

  return {
    symbol,
    timingGrade: read.timingGrade,
    entryPermission: read.entryPermission,
    bestAction: read.bestAction,
    actionReason: read.actionReason,
    heatScore: read.heatScore,
    tradeabilityScore: read.tradeabilityScore,
    dangerScore: read.dangerScore,
    tags,
    advisoryNote,
    dataQualityLabel: read.dataQuality.label,
  };
}
