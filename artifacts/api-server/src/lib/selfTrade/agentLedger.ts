// Self-Trade AI — Agent Ledger (Task #211, Foundation).
//
// Owns the per-agent capital accounting: the running snapshot
// (self_trade_agent_ledger) derived from the append-only history
// (self_trade_ledger_entries). Funding/defunding are atomic and audited.
//
// SAFETY (inviolable):
// - NO execution, lot sizing, broker dispatch, or any of the 16 live gates here.
//   This is pure accounting + audit.
// - fund/defund run inside ONE db.transaction together with the ledger entry,
//   the snapshot update, the self_trade_allocations row, and the audit row.
//   Any throw rolls everything back (fail-closed).
// - An agent can never be defunded below zero available funds.

import { and, eq } from "drizzle-orm";
import {
  db,
  selfTradeAgentsTable,
  selfTradeAgentLedgerTable,
  selfTradeLedgerEntriesTable,
  selfTradeAllocationsTable,
  selfTradeAgentExecutionsTable,
  type SelfTradeAgentLedger,
} from "@workspace/db";
import { writeSelfTradeAudit, type Tx } from "./audit.js";
import { enforceSensitiveAction } from "../security/handshake.js";

export interface FundAgentInput {
  agentId: number;
  amount: number;
  actorUserId: number;
  actorRole: string;
  reason: string;
  sourceUserId?: number | null;
  sourceSlotAllocationId?: number | null;
}

export interface DefundAgentInput {
  agentId: number;
  amount: number;
  actorUserId: number;
  actorRole: string;
  reason: string;
}

export interface LedgerResult {
  ok: boolean;
  error?: string;
  message?: string;
  ledger?: SelfTradeAgentLedger;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Ensure a snapshot row exists for the agent; returns it (locked via the tx).
async function ensureLedgerRow(tx: Tx, agentId: number): Promise<SelfTradeAgentLedger> {
  const existing = await tx
    .select()
    .from(selfTradeAgentLedgerTable)
    .where(eq(selfTradeAgentLedgerTable.agentId, agentId))
    .limit(1);
  if (existing[0]) return existing[0];
  const inserted = await tx
    .insert(selfTradeAgentLedgerTable)
    .values({ agentId })
    .returning();
  return inserted[0];
}

// Atomically fund an agent: +allocation, +ledger entry, snapshot update, audit.
// Promotes an UNFUNDED agent to FUNDED_IDLE.
export async function fundAgent(input: FundAgentInput): Promise<LedgerResult> {
  if (!(input.amount > 0)) {
    return { ok: false, error: "INVALID_AMOUNT", message: "Funding amount must be positive." };
  }
  const hs = await enforceSensitiveAction("ALLOCATE_FUNDS", {
    userId: input.actorUserId, role: input.actorRole, authenticated: true,
  });
  if (!hs.ok) return { ok: false, error: hs.reasonCode, message: hs.userMessage };
  return db.transaction(async (tx) => {
    const agentRows = await tx
      .select()
      .from(selfTradeAgentsTable)
      .where(eq(selfTradeAgentsTable.id, input.agentId))
      .limit(1);
    const agent = agentRows[0];
    if (!agent) {
      return { ok: false, error: "AGENT_NOT_FOUND", message: "Agent not found." };
    }
    if (agent.status === "ARCHIVED") {
      return { ok: false, error: "AGENT_ARCHIVED", message: "Archived agents cannot be funded." };
    }

    const before = await ensureLedgerRow(tx, input.agentId);
    const allocated = round2(before.allocatedFunds + input.amount);
    const available = round2(before.availableFunds + input.amount);

    await tx.insert(selfTradeAllocationsTable).values({
      agentId: input.agentId,
      amount: input.amount,
      sourceUserId: input.sourceUserId ?? null,
      sourceSlotAllocationId: input.sourceSlotAllocationId ?? null,
      status: "ACTIVE",
      reason: input.reason,
      createdByUserId: input.actorUserId,
    });

    await tx.insert(selfTradeLedgerEntriesTable).values({
      agentId: input.agentId,
      entryType: "FUND",
      amount: input.amount,
      balanceAfter: available,
      reason: input.reason,
      refType: "ALLOCATION",
      createdByUserId: input.actorUserId,
    });

    const updated = await tx
      .update(selfTradeAgentLedgerTable)
      .set({ allocatedFunds: allocated, availableFunds: available, updatedAt: new Date() })
      .where(eq(selfTradeAgentLedgerTable.agentId, input.agentId))
      .returning();

    // First funding promotes UNFUNDED → FUNDED_IDLE.
    const nextStatus = agent.status === "UNFUNDED" ? "FUNDED_IDLE" : agent.status;
    if (nextStatus !== agent.status) {
      await tx
        .update(selfTradeAgentsTable)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(eq(selfTradeAgentsTable.id, input.agentId));
    }

    await writeSelfTradeAudit(tx, {
      agentId: input.agentId,
      eventType: "FUND",
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      severity: "INFO",
      beforeState: { ledger: before, status: agent.status },
      afterState: { ledger: updated[0], status: nextStatus },
      reason: input.reason,
    });

    return { ok: true, ledger: updated[0] };
  });
}

// Atomically defund (withdraw available capital). Cannot exceed available.
// Releases proportional allocation accounting by recording a DEFUND entry; the
// snapshot is the source of truth for available funds.
export async function defundAgent(input: DefundAgentInput): Promise<LedgerResult> {
  if (!(input.amount > 0)) {
    return { ok: false, error: "INVALID_AMOUNT", message: "Defund amount must be positive." };
  }
  const hs = await enforceSensitiveAction("ALLOCATE_FUNDS", {
    userId: input.actorUserId, role: input.actorRole, authenticated: true,
  });
  if (!hs.ok) return { ok: false, error: hs.reasonCode, message: hs.userMessage };
  return db.transaction(async (tx) => {
    const agentRows = await tx
      .select()
      .from(selfTradeAgentsTable)
      .where(eq(selfTradeAgentsTable.id, input.agentId))
      .limit(1);
    const agent = agentRows[0];
    if (!agent) {
      return { ok: false, error: "AGENT_NOT_FOUND", message: "Agent not found." };
    }

    const before = await ensureLedgerRow(tx, input.agentId);
    if (input.amount > before.availableFunds + 1e-9) {
      return {
        ok: false,
        error: "INSUFFICIENT_AVAILABLE_FUNDS",
        message: "Cannot defund more than the agent's available funds.",
      };
    }

    const allocated = round2(Math.max(0, before.allocatedFunds - input.amount));
    const available = round2(before.availableFunds - input.amount);

    await tx.insert(selfTradeLedgerEntriesTable).values({
      agentId: input.agentId,
      entryType: "DEFUND",
      amount: -input.amount,
      balanceAfter: available,
      reason: input.reason,
      refType: "ALLOCATION",
      createdByUserId: input.actorUserId,
    });

    // Mark the most recent ACTIVE allocation as RELEASED when fully drained.
    if (allocated <= 0) {
      await tx
        .update(selfTradeAllocationsTable)
        .set({ status: "RELEASED", releasedByUserId: input.actorUserId, releasedAt: new Date() })
        .where(and(
          eq(selfTradeAllocationsTable.agentId, input.agentId),
          eq(selfTradeAllocationsTable.status, "ACTIVE"),
        ));
    }

    const updated = await tx
      .update(selfTradeAgentLedgerTable)
      .set({ allocatedFunds: allocated, availableFunds: available, updatedAt: new Date() })
      .where(eq(selfTradeAgentLedgerTable.agentId, input.agentId))
      .returning();

    // Funding invariant: a fully-drained agent reverts to UNFUNDED so it can
    // never sit in a fundable/activatable status with zero capital. We never
    // override a terminal ARCHIVED state, and an agent holding open/reserved
    // funds (not just available) stays as-is.
    let nextStatus = agent.status;
    const noCapitalLeft = available <= 1e-9 && allocated <= 1e-9;
    if (noCapitalLeft && agent.status !== "ARCHIVED" && agent.status !== "UNFUNDED") {
      nextStatus = "UNFUNDED";
      await tx
        .update(selfTradeAgentsTable)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(eq(selfTradeAgentsTable.id, input.agentId));
    }

    await writeSelfTradeAudit(tx, {
      agentId: input.agentId,
      eventType: "DEFUND",
      actorUserId: input.actorUserId,
      actorRole: input.actorRole,
      severity: "INFO",
      beforeState: { ledger: before, status: agent.status },
      afterState: { ledger: updated[0], status: nextStatus },
      reason: input.reason,
    });

    return { ok: true, ledger: updated[0] };
  });
}

export interface ApplyRealizedResult {
  posted: number;
  totalRealizedUsd: number;
}

/**
 * Reconcile realized P/L from REAL closed fills into the agent ledger (Task #213).
 *
 * Reads CLOSED executions whose realizedPnl has been computed from genuine
 * broker fill prices (open + close), and posts exactly one idempotent
 * REALIZED_PNL ledger entry per execution (refType=EXECUTION, refId=exec.id).
 * Re-running is safe: an execution already posted is skipped. The snapshot's
 * availableFunds + realizedPnl move together with the entries inside one
 * transaction (fail-closed), and the reconcile is audited.
 *
 * SAFETY: this NEVER fabricates P/L. Executions with realizedPnl=null (e.g.
 * missing a real close fill price) are intentionally not posted — they stay
 * UNKNOWN until honest evidence arrives.
 */
export async function applyRealizedFromFills(
  agentId: number,
  actorUserId?: number | null,
): Promise<ApplyRealizedResult> {
  return db.transaction(async (tx) => {
    const closed = await tx
      .select()
      .from(selfTradeAgentExecutionsTable)
      .where(
        and(
          eq(selfTradeAgentExecutionsTable.agentId, agentId),
          eq(selfTradeAgentExecutionsTable.status, "CLOSED"),
        ),
      );
    const withPnl = closed.filter((e) => e.realizedPnl != null);
    if (withPnl.length === 0) return { posted: 0, totalRealizedUsd: 0 };

    const alreadyPosted = await tx
      .select({ refId: selfTradeLedgerEntriesTable.refId })
      .from(selfTradeLedgerEntriesTable)
      .where(
        and(
          eq(selfTradeLedgerEntriesTable.agentId, agentId),
          eq(selfTradeLedgerEntriesTable.entryType, "REALIZED_PNL"),
          eq(selfTradeLedgerEntriesTable.refType, "EXECUTION"),
        ),
      );
    const postedIds = new Set(
      alreadyPosted.map((p) => p.refId).filter((x): x is number => x != null),
    );

    const unposted = withPnl.filter((e) => !postedIds.has(e.id));
    if (unposted.length === 0) return { posted: 0, totalRealizedUsd: 0 };

    const before = await ensureLedgerRow(tx, agentId);
    let available = before.availableFunds;
    let realized = before.realizedPnl;
    let total = 0;
    for (const e of unposted) {
      const amt = round2(e.realizedPnl as number);
      available = round2(available + amt);
      realized = round2(realized + amt);
      total = round2(total + amt);
      await tx.insert(selfTradeLedgerEntriesTable).values({
        agentId,
        entryType: "REALIZED_PNL",
        amount: amt,
        balanceAfter: available,
        reason: `Realized P/L for execution #${e.id} (${e.symbol} ${e.side})`,
        refType: "EXECUTION",
        refId: e.id,
        createdByUserId: actorUserId ?? null,
      });
    }

    const updated = await tx
      .update(selfTradeAgentLedgerTable)
      .set({ availableFunds: available, realizedPnl: realized, updatedAt: new Date() })
      .where(eq(selfTradeAgentLedgerTable.agentId, agentId))
      .returning();

    await writeSelfTradeAudit(tx, {
      agentId,
      eventType: "REALIZED_PNL_RECONCILE",
      actorUserId: actorUserId ?? null,
      severity: "INFO",
      beforeState: { ledger: before },
      afterState: { ledger: updated[0], posted: unposted.length, totalRealizedUsd: total },
      reason: `Posted ${unposted.length} realized P/L entr${unposted.length === 1 ? "y" : "ies"} from real fills`,
    });

    return { posted: unposted.length, totalRealizedUsd: total };
  });
}

// Read-only snapshot fetch (null when the agent has never been funded).
export async function getAgentLedger(agentId: number): Promise<SelfTradeAgentLedger | null> {
  const rows = await db
    .select()
    .from(selfTradeAgentLedgerTable)
    .where(eq(selfTradeAgentLedgerTable.agentId, agentId))
    .limit(1);
  return rows[0] ?? null;
}
