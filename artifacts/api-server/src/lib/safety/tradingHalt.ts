// One read of every stop switch that can halt a trader's orders.
//
// The platform grew several kill switches, each honoured by a different order
// path. This module reads the ones that are live safety levers and answers a
// single question for the pre-trade Risk Governor: is new risk halted for this
// trader on this venue, and by which switch?
//
//   platform_emergency_stop  global_trading_settings.emergency_kill_switch  DEMO, LIVE
//   safety_core_kill_switch  safety_core.kill_switch_engaged                PAPER, DEMO, LIVE
//   trader_kill_switch       arx_live_arming.kill_switch_engaged (per user) PAPER, DEMO, LIVE
//   allocation_frozen        user_slot_allocation (per user, shared master) DEMO, LIVE when routed via a virtual account
//
// The paper simulator never reaches a broker, so the platform emergency stop
// (which defaults to engaged on a fresh install) does not halt it; the
// safety-core switch already halted paper through the Trade Action guards.
//
// Not read here, on purpose:
//   live_trading_state.kill_switch_active  legacy placeLiveOrderGuarded path, permanently locked
//   riskGovernor2 tradingPaused            in-memory simulator OMS only
//   self_trade_kill_switches               scoped per agent/strategy; the self-trade executor reads it
//   protective_auto_close_settings         turns auto-close off; it does not halt trading
//
// A switch that cannot be read counts as engaged (fail closed).

import { and, asc, eq } from "drizzle-orm";
import {
  arxLiveArmingTable,
  db,
  globalTradingSettingsTable,
  safetyCoreTable,
  userSlotAllocationTable,
} from "@workspace/db";
import type { RiskHalt, RiskVenue } from "../riskGovernor/preTrade.js";

export type HaltSource =
  | "platform_emergency_stop"
  | "safety_core_kill_switch"
  | "trader_kill_switch"
  | "allocation_frozen";

export interface TradingHalt extends RiskHalt {
  sources: HaltSource[];
}

export const NO_HALT: TradingHalt = { engaged: false, sources: [], reason: null };

const REASONS: Record<HaltSource, string> = {
  platform_emergency_stop: "The platform emergency stop is engaged by an operator.",
  safety_core_kill_switch: "The safety-core kill switch is engaged.",
  trader_kill_switch: "Your kill switch is engaged. Release it to trade again.",
  allocation_frozen: "Your shared-account allocation is frozen by an operator.",
};

export function haltFrom(sources: HaltSource[], detail: Partial<Record<HaltSource, string | null>> = {}): TradingHalt {
  if (!sources.length) return NO_HALT;
  const first = sources[0]!;
  const extra = detail[first];
  return {
    engaged: true,
    sources,
    reason: extra ? `${REASONS[first]} (${extra})` : REASONS[first],
  };
}

async function read<T>(fn: () => Promise<T>): Promise<T | "unreadable"> {
  try { return await fn(); } catch { return "unreadable"; }
}

export async function loadTradingHalt(args: {
  userId: number;
  venue: RiskVenue;
  /** Set when the order routes through a shared master account. */
  virtualAccountId?: number | null;
}): Promise<TradingHalt> {
  const sources: HaltSource[] = [];
  const detail: Partial<Record<HaltSource, string | null>> = {};
  const broker = args.venue !== "PAPER";

  if (broker) {
    const g = await read(async () => (await db.select({
      on: globalTradingSettingsTable.emergencyKillSwitch, why: globalTradingSettingsTable.killSwitchReason,
    }).from(globalTradingSettingsTable).orderBy(asc(globalTradingSettingsTable.id)).limit(1))[0]);
    // No row: a fresh install, which is engaged by design.
    if (g === "unreadable" || !g || g.on) {
      sources.push("platform_emergency_stop");
      detail.platform_emergency_stop = g === "unreadable" ? "state unreadable" : g?.why ?? null;
    }
  }

  const sc = await read(async () => (await db.select({
    on: safetyCoreTable.killSwitchEngaged, why: safetyCoreTable.killSwitchReason,
  }).from(safetyCoreTable).orderBy(asc(safetyCoreTable.id)).limit(1))[0]);
  if (sc === "unreadable" || sc?.on) {
    sources.push("safety_core_kill_switch");
    detail.safety_core_kill_switch = sc === "unreadable" ? "state unreadable" : sc?.why ?? null;
  }

  const arm = await read(async () => (await db.select({
    on: arxLiveArmingTable.killSwitchEngaged, why: arxLiveArmingTable.killSwitchReason,
  }).from(arxLiveArmingTable).where(eq(arxLiveArmingTable.userId, args.userId)).limit(1))[0]);
  if (arm === "unreadable" || arm?.on) {
    sources.push("trader_kill_switch");
    detail.trader_kill_switch = arm === "unreadable" ? "state unreadable" : arm?.why ?? null;
  }

  if (broker && args.virtualAccountId != null) {
    const slot = await read(async () => (await db.select({
      status: userSlotAllocationTable.allocationStatus, frozen: userSlotAllocationTable.tradingFrozen,
      closeOnly: userSlotAllocationTable.closeOnlyMode,
    }).from(userSlotAllocationTable)
      .where(and(eq(userSlotAllocationTable.userId, args.userId), eq(userSlotAllocationTable.isActive, true)))
      .limit(1))[0]);
    if (slot === "unreadable" || slot?.status === "frozen" || slot?.frozen || slot?.closeOnly) {
      sources.push("allocation_frozen");
      detail.allocation_frozen = slot === "unreadable" ? "state unreadable"
        : slot?.closeOnly ? "close-only" : null;
    }
  }

  return haltFrom(sources, detail);
}
