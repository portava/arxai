import type { Trade } from "../trade/trade.types";
import type { DomainEvent } from "../events/domainEvents.types";
import type { ApproveOutput, ManageOutput, PlaceOutput } from "./pipeline.types";

// Ports = interfaces the domain depends on but does not implement. Concrete
// adapters live in `artifacts/api-server` (MT5 bridge, DB writers, etc).
// The pipeline orchestrator takes these as constructor deps so the engine
// remains pure and unit-testable with in-memory fakes.

export interface ExecutionPort {
  // Submit a new order. Adapter is responsible for idempotency keying off the
  // approved decision + correlationId.
  place(args: {
    symbol: string;
    direction: "BUY" | "SELL";
    lotSize: number;
    stopLoss: number;
    takeProfit: number | null;
    correlationId?: string | null;
  }): Promise<PlaceOutput>;

  // Apply a management action returned by the manage stage.
  modify(args: {
    tradeId: Trade["id"];
    newStopLoss?: number;
    newTakeProfit?: number;
  }): Promise<{ ok: boolean; reason?: string }>;

  closePartial(args: {
    tradeId: Trade["id"];
    fraction: number;
  }): Promise<{ ok: boolean; reason?: string }>;

  closeFull(args: {
    tradeId: Trade["id"];
    reason: string;
  }): Promise<{ ok: boolean; exitPrice: number; pnl: number }>;
}

export interface MonitorPort {
  // Snapshot the current price + intra-trade extremes for an open trade.
  // Used by the manage stage to compute trade health.
  snapshot(tradeId: Trade["id"]): Promise<{
    currentPrice: number;
    highSinceOpen: number;
    lowSinceOpen: number;
    ageSeconds: number;
  } | null>;
}

export interface AuditPort {
  // Persist a batch of domain events. Adapter is responsible for transactional
  // append + downstream fan-out (websocket, log, etc).
  record(events: DomainEvent[]): Promise<void>;
}

// Convenience bundle the orchestrator accepts.
export interface PipelinePorts {
  execution: ExecutionPort;
  monitor: MonitorPort;
  audit: AuditPort;
}

// In-memory no-op ports useful for tests and for the orchestrator's
// type-safety in MOCK mode.
export const NULL_PORTS: PipelinePorts = {
  execution: {
    async place() { throw new Error("ExecutionPort.place not implemented"); },
    async modify() { return { ok: false, reason: "not implemented" }; },
    async closePartial() { return { ok: false, reason: "not implemented" }; },
    async closeFull() { throw new Error("ExecutionPort.closeFull not implemented"); },
  },
  monitor: { async snapshot() { return null; } },
  audit:   { async record() { /* discard */ } },
};

// Apply ManageOutput against the ExecutionPort. Pure-ish wrapper that returns
// a uniform result shape regardless of action.
export async function applyManageAction(
  port: ExecutionPort,
  m: ManageOutput,
): Promise<{ ok: boolean; reason?: string }> {
  switch (m.action) {
    case "HOLD":           return { ok: true };
    case "MOVE_SL":
    case "MOVE_TP":
    case "TRAIL":          return port.modify({
      tradeId: m.tradeId,
      newStopLoss: m.newStopLoss,
      newTakeProfit: m.newTakeProfit,
    });
    case "PARTIAL_CLOSE":  return port.closePartial({
      tradeId: m.tradeId, fraction: m.closeFraction ?? 0.5,
    });
    case "FULL_CLOSE":     return (await port.closeFull({
      tradeId: m.tradeId, reason: m.reason,
    })).ok ? { ok: true } : { ok: false };
  }
}

// Re-export approved-output helpers for symmetry with the manage helper.
export type { ApproveOutput, PlaceOutput, ManageOutput };
