// Self-Trade AI — Supervisor (Task #211, Foundation skeleton).
//
// The supervisor monitors fleet health. In a LATER phase it will react to
// drawdown / loss-cap / stale-heartbeat conditions. In the foundation phase it
// is COMPUTE-ONLY: it derives a read-only health snapshot per agent and a fleet
// roll-up the control room can render. It NEVER closes a position, pauses an
// agent automatically, or touches any execution surface — auto-close stays
// ALERT_ONLY across the whole product.

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  db,
  selfTradeAgentsTable,
  selfTradeAgentSettingsTable,
  type SelfTradeAgent,
} from "@workspace/db";
import { readAccountingRows, projectAccounting, combineAccounting, type AccountingCoverage } from "./accountingCoverage.js";

export type AgentHealthBand = "HEALTHY" | "WATCH" | "AT_RISK" | "UNKNOWN";

export interface AgentHealth {
  agentId: number;
  agentKey: string;
  status: SelfTradeAgent["status"];
  band: AgentHealthBand;
  allocatedFunds: number | null;
  availableFunds: number | null;
  openPnl: number | null;
  realizedPnl: number | null;
  dailyLossUsed: number | null; // Current UTC day's recorded net loss; null when coverage is incomplete.
  dailyLossCapUsd: number;
  notes: string[];
  accounting: AccountingCoverage;
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
  accounting: AccountingCoverage;
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
export async function computeFleetHealth(scope?: { userId: number; includeOperatorFleet?: boolean }, now = new Date()): Promise<FleetHealth> {
  const ownerWhere = scope ? or(
    and(eq(selfTradeAgentsTable.ownerType, "USER"), eq(selfTradeAgentsTable.ownerId, scope.userId)),
    scope.includeOperatorFleet ? and(eq(selfTradeAgentsTable.ownerType, "OPERATOR_FLEET"), isNull(selfTradeAgentsTable.ownerId), eq(selfTradeAgentsTable.createdByUserId, scope.userId)) : undefined,
  ) : undefined;
  const agents = await db.select().from(selfTradeAgentsTable).where(ownerWhere);
  const ids = agents.map((a) => a.id);

  const [ledgers, settings] = await Promise.all([
    readAccountingRows(ids, ownerWhere, now),
    ids.length ? db.select().from(selfTradeAgentSettingsTable).where(inArray(selfTradeAgentSettingsTable.agentId, ids)) : [],
  ]);

  const ledgerByAgent = new Map(ledgers.map((l) => [l.agentId, l]));
  const settingsByAgent = new Map(settings.map((s) => [s.agentId, s]));

  const agentHealth: AgentHealth[] = agents.map((a) => {
    const l = ledgerByAgent.get(a.id);
    const s = settingsByAgent.get(a.id);
    const recorded = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value : null;
    const allocated = recorded(l?.allocatedFunds);
    const available = recorded(l?.availableFunds);
    const realized = recorded(l?.realizedPnl);
    const accounting = projectAccounting(l, now);
    const realizedLoss = accounting.dailyLossUsed;
    const cap = s?.maxDailyLossUsd ?? 0;
    const notes: string[] = [...accounting.notes];
    if (allocated != null && allocated <= 0) notes.push("Unfunded — no capital allocated.");
    if (!s) notes.push("No settings row — using defaults.");
    return {
      agentId: a.id,
      agentKey: a.agentKey,
      status: a.status,
      band: accounting.status !== "RECORDED" || realizedLoss == null || available == null || allocated == null ? "UNKNOWN" : bandFor(available, allocated, realizedLoss, cap),
      allocatedFunds: allocated,
      availableFunds: available,
      openPnl: recorded(l?.openPnl),
      realizedPnl: realized,
      dailyLossUsed: realizedLoss,
      dailyLossCapUsd: cap,
      notes,
      accounting,
    };
  });

  return {
    totalAgents: agents.length,
    activeAgents: agents.filter((a) => a.status === "ACTIVE").length,
    fundedAgents: agentHealth.filter((a) => a.allocatedFunds != null && a.allocatedFunds > 0).length,
    totalAllocated: agentHealth.reduce((s, a) => s + (a.allocatedFunds ?? 0), 0),
    totalAvailable: agentHealth.reduce((s, a) => s + (a.availableFunds ?? 0), 0),
    totalOpenPnl: agentHealth.reduce((s, a) => s + (a.openPnl ?? 0), 0),
    totalRealizedPnl: agentHealth.reduce((s, a) => s + (a.realizedPnl ?? 0), 0),
    agents: agentHealth,
    accounting: combineAccounting(agentHealth.map(a => a.accounting), now),
  };
}

export async function computeAgentHealth(agentId: number): Promise<AgentHealth | null> {
  const fleet = await computeFleetHealth();
  return fleet.agents.find((a) => a.agentId === agentId) ?? null;
}
