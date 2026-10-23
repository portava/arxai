// Self-Trade AI — Supervisor (Task #211, Foundation skeleton).
//
// The supervisor monitors fleet health. In a LATER phase it will react to
// drawdown / loss-cap / stale-heartbeat conditions. In the foundation phase it
// is COMPUTE-ONLY: it derives a read-only health snapshot per agent and a fleet
// roll-up the control room can render. It NEVER closes a position, pauses an
// agent automatically, or touches any execution surface — auto-close stays
// ALERT_ONLY across the whole product.

import { eq, inArray } from "drizzle-orm";
import {
  db,
  selfTradeAgentsTable,
  selfTradeAgentSettingsTable,
  selfTradeAgentLedgerTable,
  type SelfTradeAgent,
} from "@workspace/db";

export type AgentHealthBand = "HEALTHY" | "WATCH" | "AT_RISK" | "UNKNOWN";

export interface AgentHealth {
  agentId: number;
  agentKey: string;
  status: SelfTradeAgent["status"];
  band: AgentHealthBand;
  allocatedFunds: number;
  availableFunds: number;
  openPnl: number;
  realizedPnl: number;
  dailyLossUsed: number;     // |realized loss| measured against the cap (read-only)
  dailyLossCapUsd: number;
  notes: string[];
}

export interface FleetHealth {
  totalAgents: number;
  activeAgents: number;
  fundedAgents: number;
  totalAllocated: number;
  totalAvailable: number;
  totalOpenPnl: number;
  totalRealizedPnl: number;
  agents: AgentHealth[];
}

function bandFor(
  availableFunds: number,
  allocatedFunds: number,
  realizedLoss: number,
  dailyLossCapUsd: number,
): AgentHealthBand {
  if (allocatedFunds <= 0) return "UNKNOWN";
  if (dailyLossCapUsd > 0) {
    const ratio = realizedLoss / dailyLossCapUsd;
    if (ratio >= 0.9) return "AT_RISK";
    if (ratio >= 0.5) return "WATCH";
  }
  if (availableFunds <= allocatedFunds * 0.25) return "WATCH";
  return "HEALTHY";
}

// Read-only fleet health roll-up. No side effects, no execution.
export async function computeFleetHealth(): Promise<FleetHealth> {
  const agents = await db.select().from(selfTradeAgentsTable);
  const ids = agents.map((a) => a.id);

  const ledgers = ids.length
    ? await db.select().from(selfTradeAgentLedgerTable)
        .where(inArray(selfTradeAgentLedgerTable.agentId, ids))
    : [];
  const settings = ids.length
    ? await db.select().from(selfTradeAgentSettingsTable)
        .where(inArray(selfTradeAgentSettingsTable.agentId, ids))
    : [];

  const ledgerByAgent = new Map(ledgers.map((l) => [l.agentId, l]));
  const settingsByAgent = new Map(settings.map((s) => [s.agentId, s]));

  const agentHealth: AgentHealth[] = agents.map((a) => {
    const l = ledgerByAgent.get(a.id);
    const s = settingsByAgent.get(a.id);
    const allocated = l?.allocatedFunds ?? 0;
    const available = l?.availableFunds ?? 0;
    const realized = l?.realizedPnl ?? 0;
    const realizedLoss = realized < 0 ? Math.abs(realized) : 0;
    const cap = s?.maxDailyLossUsd ?? 0;
    const notes: string[] = [];
    if (allocated <= 0) notes.push("Unfunded — no capital allocated.");
    if (!s) notes.push("No settings row — using defaults.");
    return {
      agentId: a.id,
      agentKey: a.agentKey,
      status: a.status,
      band: bandFor(available, allocated, realizedLoss, cap),
      allocatedFunds: allocated,
      availableFunds: available,
      openPnl: l?.openPnl ?? 0,
      realizedPnl: realized,
      dailyLossUsed: realizedLoss,
      dailyLossCapUsd: cap,
      notes,
    };
  });

  return {
    totalAgents: agents.length,
    activeAgents: agents.filter((a) => a.status === "ACTIVE").length,
    fundedAgents: agentHealth.filter((a) => a.allocatedFunds > 0).length,
    totalAllocated: agentHealth.reduce((s, a) => s + a.allocatedFunds, 0),
    totalAvailable: agentHealth.reduce((s, a) => s + a.availableFunds, 0),
    totalOpenPnl: agentHealth.reduce((s, a) => s + a.openPnl, 0),
    totalRealizedPnl: agentHealth.reduce((s, a) => s + a.realizedPnl, 0),
    agents: agentHealth,
  };
}

export async function computeAgentHealth(agentId: number): Promise<AgentHealth | null> {
  const fleet = await computeFleetHealth();
  return fleet.agents.find((a) => a.agentId === agentId) ?? null;
}
