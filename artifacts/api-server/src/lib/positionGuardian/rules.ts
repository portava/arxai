// Position Guardian — the registry of post-entry management rules.
//
// Every engine that reasons about an OPEN position is a guardian rule listed
// here, with the modules that implement it and the actions it may take. The
// guardian is the one authority for managing open exposure:
//
//   * an ADVISORY rule reads positions and produces alerts, health reads or
//     suggestions. It never reaches an execution path.
//   * an ACTING rule may request only the actions listed for it, and only
//     through lib/positionGuardian/manage.ts, which checks the request against
//     this registry, refuses anything that widens a stop, and hands it to the
//     governed path for its venue (the Risk Governor and dispatch gates still
//     decide).
//
// No rule can open a position or add size: those actions do not exist here.
// CI guard `single-position-guardian` keeps rule modules off the execution
// paths and fails when an unregistered module both reads positions and
// executes. This file is pure data so the guard can import it.

export type GuardianRuleKind = "ADVISORY" | "ACTING";

/** Every management action a rule can request. None opens or adds exposure. */
export type GuardianManagementAction =
  | "RESTORE_STOP"   // put back the governed stop (always tighter than the broker's)
  | "MOVE_STOP"      // break-even / trail; refused if it would widen
  | "MOVE_TARGET"    // change the take-profit; adds no risk
  | "PARTIAL_CLOSE"  // reduce size
  | "CLOSE";         // close the whole position

/** Where an acting rule's request is executed. */
export type GuardianRoute =
  | "GOVERNED_OPS"         // lib/positions/governedOps.ts (LIVE/DEMO venue queues)
  | "TRADE_ACTION_CENTER"  // lib/tradeAction draft → confirm (venue queues per #26)
  | "INSTANT_ROUTER"       // lib/live/instantTrade.ts executeInstant (18-gate Phase B)
  | "PAPER_BOOK";          // simulated trades table (no broker)

export interface GuardianRule {
  id: string;
  label: string;
  kind: GuardianRuleKind;
  /** Implementation modules, relative to artifacts/api-server/src. */
  modules: readonly string[];
  /** Empty for ADVISORY rules. */
  actions: readonly GuardianManagementAction[];
  route: GuardianRoute | null;
}

export const GUARDIAN_RULES = [
  {
    id: "position-protection",
    label: "Post-fill protection check (restore a missing or widened stop)",
    kind: "ACTING",
    modules: ["lib/positionGuardian/assess.ts", "lib/positionGuardian/reconcile.ts"],
    actions: ["RESTORE_STOP"],
    route: "GOVERNED_OPS",
  },
  {
    id: "protective-close",
    label: "Protective auto-close (inactivity + reversal)",
    kind: "ACTING",
    modules: [
      "lib/protectiveClose/decide.ts",
      "lib/protectiveClose/engine.ts",
      "lib/protectiveClose/inactivity.ts",
      "lib/protectiveClose/journal.ts",
      "lib/protectiveClose/reversalSignals.ts",
      "lib/protectiveClose/settings.ts",
      "lib/intelligence/protectiveCloseHook.ts",
    ],
    actions: ["PARTIAL_CLOSE", "CLOSE"],
    route: "TRADE_ACTION_CENTER",
  },
  {
    id: "trade-monitor",
    label: "Real-time trade monitor (exit alerts; schedules protective-close)",
    kind: "ADVISORY",
    modules: ["lib/intelligence/monitorWorker.ts"],
    actions: [],
    route: null,
  },
  {
    id: "mission-exit",
    label: "Profit Mission exit manager (break-even, trail, partials, exits)",
    kind: "ACTING",
    modules: ["lib/missionExitManager.ts"],
    actions: ["MOVE_STOP", "MOVE_TARGET", "PARTIAL_CLOSE", "CLOSE"],
    route: "INSTANT_ROUTER",
  },
  {
    id: "self-trade-manage",
    label: "Self-Trade agent position manager (break-even, tighten, exit)",
    kind: "ACTING",
    modules: ["lib/selfTrade/livePositionManager.ts"],
    actions: ["MOVE_STOP", "CLOSE"],
    route: "INSTANT_ROUTER",
  },
  {
    id: "trade-health",
    label: "Live trade health and management advice",
    kind: "ADVISORY",
    modules: ["lib/tradeHealth/tradeHealthService.ts"],
    actions: [],
    route: null,
  },
  {
    id: "scalp-manage",
    label: "Scalp baskets, add-on and exit-urgency advice",
    kind: "ADVISORY",
    modules: ["lib/scalp/scalpManage.ts", "lib/scalp/scalpManageService.ts"],
    actions: [],
    route: null,
  },
  {
    id: "trade-management",
    label: "Simulated-trade break-even, trail, partial and close",
    kind: "ACTING",
    modules: [
      "lib/tradeManagement/tradeManager.ts",
      "lib/tradeManagement/monitoring/tradeHealthScore.ts",
      "lib/tradeManagement/rules/breakEvenRules.ts",
      "lib/tradeManagement/rules/earlyExitRules.ts",
      "lib/tradeManagement/rules/partialCloseRules.ts",
      "lib/tradeManagement/rules/trailingStopRules.ts",
      "routes/tradeManagement.ts",
    ],
    actions: ["MOVE_STOP", "PARTIAL_CLOSE", "CLOSE"],
    route: "PAPER_BOOK",
  },
] as const satisfies readonly GuardianRule[];

export type GuardianRuleId = (typeof GUARDIAN_RULES)[number]["id"];

export function guardianRule(id: string): GuardianRule | null {
  return (GUARDIAN_RULES as readonly GuardianRule[]).find((r) => r.id === id) ?? null;
}

/** The module that turns an acting rule's request into a governed operation. */
export const GUARDIAN_MANAGE_MODULE = "lib/positionGuardian/manage.ts";
