// Capability #28 — DRILL FIXTURES.
//
// A watchdog is only trustworthy if someone has watched it notice. These are
// the seeded conditions the drill (docs/WATCHDOG_DRILL.md) replays, shared by
// the offline test suite and the runnable drill script
// (src/scripts/watchdogDrill.ts) so the drill exercises the REAL assessment
// core, the REAL envelope, and the REAL notification mapper — not a
// re-description of them.
//
// PURE: fixture data only. No DB, no network, no clock read (`DRILL_NOW` is a
// fixed instant so every run of the drill is byte-comparable).

import type { WatchdogSnapshot, WatchdogPositionRow, WatchdogCommandRow } from "./watchdogCore.js";
import { MAIN_APP_SILENT_MS } from "./watchdogCore.js";

/** Fixed drill instant, so the drill's output is deterministic. */
export const DRILL_NOW_MS = Date.parse("2026-08-29T12:00:00.000Z");

export type DrillScenarioId =
  | "baseline_all_clear"
  | "position_without_protective_orders"
  | "main_app_outage"
  | "database_unreadable";

export interface DrillScenario {
  id: DrillScenarioId;
  title: string;
  /** What a human is proving by running it. */
  proves: string;
  /** Finding keys that MUST appear. The drill fails if any is missing. */
  expectedFindingKeys: string[];
  /** Verdict the pass must reach. */
  expectedVerdict: "VERIFIED_HEALTHY" | "FINDINGS" | "CANNOT_VERIFY";
  snapshot: WatchdogSnapshot;
}

function position(overrides: Partial<WatchdogPositionRow> = {}): WatchdogPositionRow {
  return {
    id: 9001,
    userId: 7,
    symbol: "EURUSD",
    direction: "BUY",
    lotSize: 0.1,
    stopLoss: 1.0785,
    status: "OPEN",
    closedAt: null,
    lastSyncedAt: new Date(DRILL_NOW_MS - 10_000),
    ...overrides,
  };
}

function command(overrides: Partial<WatchdogCommandRow> = {}): WatchdogCommandRow {
  return { id: 5001, status: "PENDING", action: "OPEN", createdAt: new Date(DRILL_NOW_MS - 10_000), ...overrides };
}

/** A snapshot in which everything is readable and nothing is wrong. */
function healthySnapshot(): WatchdogSnapshot {
  return {
    openPositions: { ok: true, value: [position()] },
    nonTerminalCommands: { ok: true, value: [command()] },
    latestHealthCheckAt: { ok: true, value: new Date(DRILL_NOW_MS - 30_000) },
    latestAuditEventAt: { ok: true, value: new Date(DRILL_NOW_MS - 45_000) },
    killSwitchEngaged: { ok: true, value: false },
  };
}

export const DRILL_SCENARIOS: readonly DrillScenario[] = [
  {
    id: "baseline_all_clear",
    title: "Baseline — everything readable, everything protected",
    proves: "the drill's own control: the watchdog does NOT cry wolf on a healthy system, so a finding in the next scenarios means something.",
    expectedFindingKeys: [],
    expectedVerdict: "VERIFIED_HEALTHY",
    snapshot: healthySnapshot(),
  },
  {
    id: "position_without_protective_orders",
    title: "An open position carries NO protective order",
    proves: "the watchdog notices an unprotected open position and raises it at CRITICAL — the single condition capability #28 exists for.",
    expectedFindingKeys: ["unprotected_position:9002"],
    expectedVerdict: "FINDINGS",
    snapshot: {
      ...healthySnapshot(),
      openPositions: {
        ok: true,
        value: [
          position(),                                              // protected — must NOT alert
          position({ id: 9002, symbol: "XAUUSD", direction: "SELL", lotSize: 0.25, stopLoss: null }),
        ],
      },
    },
  },
  {
    id: "main_app_outage",
    title: "The main app has stopped writing any evidence of life",
    proves: "with the api-server dead, the watchdog — running outside it — still notices and alerts. An in-process watchdog cannot do this, which is why this process exists.",
    expectedFindingKeys: ["main_app_silent"],
    expectedVerdict: "FINDINGS",
    snapshot: {
      ...healthySnapshot(),
      latestHealthCheckAt: { ok: true, value: new Date(DRILL_NOW_MS - MAIN_APP_SILENT_MS - 60_000) },
      latestAuditEventAt: { ok: true, value: new Date(DRILL_NOW_MS - MAIN_APP_SILENT_MS - 120_000) },
    },
  },
  {
    id: "database_unreadable",
    title: "The watchdog cannot read protection state at all",
    proves: "UNVERIFIABLE is never reported as healthy: an unreadable section is a CRITICAL cannot_verify, the pass verdict is CANNOT_VERIFY, and /healthz returns 503.",
    expectedFindingKeys: ["cannot_verify:open_positions"],
    expectedVerdict: "CANNOT_VERIFY",
    snapshot: {
      ...healthySnapshot(),
      openPositions: { ok: false, reason: "drill: relation \"live_positions\" is not readable by this session" },
    },
  },
];

export function drillScenario(id: DrillScenarioId): DrillScenario {
  const s = DRILL_SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`unknown drill scenario: ${id}`);
  return s;
}
