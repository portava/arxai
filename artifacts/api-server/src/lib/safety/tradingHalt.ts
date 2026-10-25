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
// Stop switches default to released (broker execution controls are separate): a fresh install, restart or redeploy
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
import { readBrokerHealthState } from "../brokerHub/brokerHealthState.js";
import {
  PLATFORM_STOP_REASONS,
  platformStop,
  platformStopForVenue,
  readPlatformSwitches,
  type PlatformMode,
} from "./platformSwitches.js";

export type HaltSource =
  | "platform_emergency_stop"
  | "safety_core_kill_switch"
  | "trader_kill_switch"
  | "allocation_frozen"
  | BrokerControlBlock;

export interface TradingHalt extends RiskHalt {
  sources: HaltSource[];
}

export const NO_HALT: TradingHalt = { engaged: false, sources: [], reason: null };

const REASONS: Record<HaltSource, string> = {
  ...PLATFORM_STOP_REASONS,
  trader_kill_switch: "Your kill switch is engaged. Release it to trade again.",
  allocation_frozen: "Your shared-account allocation is frozen by an operator.",
  broker_execution_disabled: "Broker execution is disabled by the operator. No new positions can be opened on this venue.",
  broker_maintenance_mode: "The broker is in maintenance mode. No new positions can be opened on this venue.",
  broker_controls_unreadable: "The broker operator controls could not be read. No new positions can be opened on this venue.",
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
  await addInstallWideStops(sources, detail, "LIVE");
  return haltFrom(sources, detail);
}

// Both install-wide stops through the one platform-stop read (platformStop).
// No settings row: a fresh install, which starts released (schema defaults).
// No safety_core row yet: released (lib/safetyCore.ts seeds it at boot).
// The paper simulator is not halted by the emergency stop (platformStopForVenue).
async function addInstallWideStops(
  sources: HaltSource[],
  detail: Partial<Record<HaltSource, string | null>>,
  venue: RiskVenue,
): Promise<void> {
  const stop = platformStopForVenue(await platformStop(), venue);
  for (const s of stop.sources) {
    sources.push(s);
    detail[s] = stop.detail[s] ?? null;
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

  await addInstallWideStops(sources, detail, args.venue);

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

// ── Broker operator controls (owner decision 2, round 5) ───────────────────
//
// Broker Hub supplies the facts (broker_health_state.execution_enabled and
// maintenance_mode, read only through lib/brokerHub/brokerHealthState.ts);
// Platform Safety decides what they mean for a venue: on DEMO and LIVE,
// execution disabled or maintenance on blocks NEW RISK. Closes, cancels and
// protection are not blocked by them. PAPER reaches no broker and is never
// blocked by them.
//
// Fail closed for new risk: an unreadable row blocks. No row yet reads as the
// schema defaults (execution_enabled=false), i.e. execution not enabled.

export interface BrokerOperatorControls {
  readable: boolean;
  /** False when no broker_health_state row exists yet (schema defaults apply). */
  present: boolean;
  executionEnabled: boolean;
  maintenanceMode: boolean;
}

export type BrokerControlBlock = "broker_execution_disabled" | "broker_maintenance_mode" | "broker_controls_unreadable";

const BROKER_CONTROL_REASONS: Record<BrokerControlBlock, string> = {
  broker_execution_disabled: "Broker execution is disabled by the operator. No new positions can be opened on this venue.",
  broker_maintenance_mode: "The broker is in maintenance mode. No new positions can be opened on this venue.",
  broker_controls_unreadable: "The broker's operator controls could not be read. No new positions can be opened on this venue.",
};

/** Read the operator controls through the Broker Hub reader. Never throws. */
export async function readBrokerOperatorControls(): Promise<BrokerOperatorControls> {
  try {
    const row = await readBrokerHealthState();
    if (!row) return { readable: true, present: false, executionEnabled: false, maintenanceMode: false };
    return { readable: true, present: true, executionEnabled: row.executionEnabled === true, maintenanceMode: row.maintenanceMode === true };
  } catch {
    return { readable: false, present: false, executionEnabled: false, maintenanceMode: true };
  }
}

/**
 * Pure: which operator controls block this action on this venue. Only new
 * risk on DEMO/LIVE is ever blocked; closes / cancels / protection and PAPER
 * never are.
 */
export function brokerControlBlocks(
  controls: BrokerOperatorControls,
  args: { venue: RiskVenue; opensNewRisk: boolean },
): BrokerControlBlock[] {
  if (args.venue === "PAPER" || !args.opensNewRisk) return [];
  if (!controls.readable) return ["broker_controls_unreadable"];
  const out: BrokerControlBlock[] = [];
  if (!controls.executionEnabled) out.push("broker_execution_disabled");
  if (controls.maintenanceMode) out.push("broker_maintenance_mode");
  return out;
}

/** Execution and readiness use the same policy. The governor applies this halt
 * only to new exposure / widening; closing and tightening retain their checks. */
export async function loadBrokerControlHalt(venue: RiskVenue): Promise<TradingHalt> {
  if (venue === "PAPER") return NO_HALT;
  return haltFrom(brokerControlBlocks(await readBrokerOperatorControls(), { venue, opensNewRisk: true }));
}

export interface VenueTradingVerdict {
  venue: RiskVenue;
  /** True only when the venue is open on the platform, no stop halts the trader there, and (new risk on DEMO/LIVE) the broker's operator controls allow it. */
  allowed: boolean;
  /** PAPER is never closed by a platform venue switch (the simulator reaches no broker). */
  venueOpen: boolean;
  platformMode: PlatformMode | null;
  halt: TradingHalt;
  /** The action the verdict was asked about (default: new risk). */
  opensNewRisk: boolean;
  /** DEMO/LIVE: the broker's operator controls as read (null for PAPER). */
  brokerControls: BrokerOperatorControls | null;
  /** The operator controls that block this action (empty when none, always empty for closes and PAPER). */
  brokerControlBlocks: BrokerControlBlock[];
  /** Why not, strictest first; empty when allowed. */
  reasons: string[];
}

/**
 * The one answer to "may this venue trade now, and why not": the platform
 * venue switch (platformSwitches) AND every stop switch (loadTradingHalt)
 * AND, for new risk on DEMO/LIVE, the broker's operator controls (owner
 * decision 2). Adds no gate and approves nothing; the order path still runs
 * its guards and the pre-trade Risk Governor. Missing settings are seeded from
 * the schema defaults, as the order path's envelope does; a read failure fails
 * closed. `opensNewRisk: false` (a close, cancel or protection change) is not
 * blocked by the operator controls; the venue switch and stops answer as before.
 */
export async function venueTradingVerdict(args: {
  userId: number;
  venue: RiskVenue;
  virtualAccountId?: number | null;
  opensNewRisk?: boolean;
  readBrokerControls?: () => Promise<BrokerOperatorControls>;
}): Promise<VenueTradingVerdict> {
  const opensNewRisk = args.opensNewRisk ?? true;
  const broker = args.venue !== "PAPER";
  const [sw, halt, controls] = await Promise.all([
    broker ? readPlatformSwitches({ ifMissing: "seed" }) : Promise.resolve(null),
    loadTradingHalt(args).catch((): TradingHalt => ({ engaged: true, sources: [], reason: null })),
    broker
      ? (args.readBrokerControls ?? readBrokerOperatorControls)()
        .catch((): BrokerOperatorControls => ({ readable: false, present: false, executionEnabled: false, maintenanceMode: true }))
      : Promise.resolve(null),
  ]);
  const venueOpen = sw ? sw.venueOpen[args.venue as "DEMO" | "LIVE"] : true;
  const blocks = controls ? brokerControlBlocks(controls, { venue: args.venue, opensNewRisk }) : [];
  const reasons: string[] = [];
  if (halt.engaged) reasons.push(halt.reason ?? "A stop switch is engaged.");
  if (!venueOpen) reasons.push(`The ${args.venue.toLowerCase()} venue is switched off by the admin.`);
  for (const b of blocks) reasons.push(BROKER_CONTROL_REASONS[b]);
  return {
    venue: args.venue,
    allowed: venueOpen && !halt.engaged && blocks.length === 0,
    venueOpen,
    platformMode: sw?.platformMode ?? null,
    halt,
    opensNewRisk,
    brokerControls: controls,
    brokerControlBlocks: blocks,
    reasons,
  };
}
