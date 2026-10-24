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
// does not halt it; the safety-core switch already halted paper through the
// Trade Action guards.
//
// Every switch defaults to released: a fresh install, restart or redeploy
// does not halt trading (owner decision 2026-10-24). Only an engaged switch
// halts.
//
// Not read here, on purpose:
//   live_trading_state.kill_switch_active  legacy placeLiveOrderGuarded path, permanently locked
//   self_trade_kill_switches               scoped per agent/strategy; the self-trade executor reads it
//   protective_auto_close_settings         turns auto-close off; it does not halt trading
//
// A switch that cannot be read counts as engaged (fail closed).
//
// The install-wide switches are read through ./platformSwitches.ts (the one
// read authority for them); only the per-trader rows are read here.

import { and, eq } from "drizzle-orm";
import { arxLiveArmingTable, db, userSlotAllocationTable } from "@workspace/db";
import type { RiskHalt, RiskVenue } from "../riskGovernor/preTrade.js";
import { readPlatformSwitches, readSafetyCoreSwitch, type PlatformMode } from "./platformSwitches.js";

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

/** The install-wide switches only (emergency stop, safety core), for fleet-level views. */
export async function loadPlatformHalt(): Promise<TradingHalt> {
  const sources: HaltSource[] = [];
  const detail: Partial<Record<HaltSource, string | null>> = {};
  await addPlatformStop(sources, detail);
  await addSafetyCoreStop(sources, detail);
  return haltFrom(sources, detail);
}

// No settings row: a fresh install, which starts released (schema defaults).
async function addPlatformStop(sources: HaltSource[], detail: Partial<Record<HaltSource, string | null>>): Promise<void> {
  const g = await readPlatformSwitches({ ifMissing: "defaults" });
  if (g.emergencyStop.engaged) {
    sources.push("platform_emergency_stop");
    detail.platform_emergency_stop = g.readable ? g.emergencyStop.reason : "state unreadable";
  }
}

// No safety_core row yet: released (lib/safetyCore.ts seeds it at boot).
async function addSafetyCoreStop(sources: HaltSource[], detail: Partial<Record<HaltSource, string | null>>): Promise<void> {
  const sc = await readSafetyCoreSwitch();
  if (sc.engaged) {
    sources.push("safety_core_kill_switch");
    detail.safety_core_kill_switch = sc.readable ? sc.reason : "state unreadable";
  }
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

  if (broker) await addPlatformStop(sources, detail);
  await addSafetyCoreStop(sources, detail);

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

// ── May this venue trade now, and why not ──────────────────────────────────

export interface VenueTradingVerdict {
  venue: RiskVenue;
  /** True only when the venue is open on the platform and no stop halts the trader there. */
  allowed: boolean;
  /** PAPER is never closed by a platform venue switch (the simulator reaches no broker). */
  venueOpen: boolean;
  platformMode: PlatformMode | null;
  halt: TradingHalt;
  /** Why not, strictest first; empty when allowed. */
  reasons: string[];
}

/**
 * The one answer to "may this venue trade now, and why not": the platform
 * venue switch (platformSwitches) AND every stop switch (loadTradingHalt).
 * Adds no gate and approves nothing; the order path still runs its guards
 * and the pre-trade Risk Governor. Missing settings are seeded from the
 * schema defaults, as the order path's envelope does; a read failure fails
 * closed.
 */
export async function venueTradingVerdict(args: {
  userId: number;
  venue: RiskVenue;
  virtualAccountId?: number | null;
}): Promise<VenueTradingVerdict> {
  const [sw, halt] = await Promise.all([
    args.venue === "PAPER" ? Promise.resolve(null) : readPlatformSwitches({ ifMissing: "seed" }),
    loadTradingHalt(args).catch((): TradingHalt => ({ engaged: true, sources: [], reason: null })),
  ]);
  const venueOpen = sw ? sw.venueOpen[args.venue as "DEMO" | "LIVE"] : true;
  const reasons: string[] = [];
  if (halt.engaged) reasons.push(halt.reason ?? "A stop switch is engaged.");
  if (!venueOpen) reasons.push(`The ${args.venue.toLowerCase()} venue is switched off by the admin.`);
  return { venue: args.venue, allowed: venueOpen && !halt.engaged, venueOpen, platformMode: sw?.platformMode ?? null, halt, reasons };
}
