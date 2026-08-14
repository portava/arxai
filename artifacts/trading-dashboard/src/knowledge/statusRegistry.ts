/**
 * ARX status / badge source-of-truth registry.
 *
 * One canonical record per status badge with: meaning, severity, what it
 * blocks, what it allows, the safety reason, related route, assistant
 * explanation, and safe next step. Used by the assistant Guide tab,
 * "Explain badges" answers, and badge coverage tests.
 *
 * Adding a new badge here is the only place needed — answer composers,
 * coverage tests, and the Guide tab read from this registry.
 */
export type StatusSeverity = "info" | "good" | "warn" | "critical";

export interface StatusEntry {
  id: string;
  label: string;
  meaning: string;
  severity: StatusSeverity;
  blocks: string[];
  allows: string[];
  safetyReason: string;
  related?: { label: string; route: string };
  explanation: string;
  safeNextStep: string;
}

export const STATUS_REGISTRY: StatusEntry[] = [
  {
    id: "paper-only",
    label: "DEMO ONLY",
    meaning: "Every order in ARX is currently simulated against the in-process demo engine.",
    severity: "good",
    blocks: ["broker order placement", "real-money trades"],
    allows: ["demo trades", "simulator scans", "strategy review", "journal entries"],
    safetyReason: "Demo Only is the safe default — no broker is ever touched.",
    related: { label: "Demo Trading", route: "/demo-trading" },
    explanation: "ARX boots in Demo Only mode. You can practice strategies, run simulator scans, and review your demo P&L without any broker connection.",
    safeNextStep: "Open Demo Trading and run a demo session to practice safely.",
  },
  {
    id: "live-trading-disabled",
    label: "LIVE TRADING DISABLED",
    meaning: "The live trading code path is disabled at the platform level.",
    severity: "good",
    blocks: ["any live broker execution", "real-money order placement"],
    allows: ["all demo / simulator / replay flows"],
    safetyReason: "Server-enforced lock. The assistant cannot toggle this; the user controls it via documented configuration only.",
    related: { label: "Readiness Checklist", route: "/readiness-checklist" },
    explanation: "ARX is intentionally read-only against any broker until the MT5 bridge is configured and every readiness gate is green.",
    safeNextStep: "Treat this as the safe default. Use demo mode while you finish setup.",
  },
  {
    id: "live-broker-execution-disabled",
    label: "LIVE BROKER EXECUTION DISABLED",
    meaning: "Even if the bridge were connected, the order router will not forward orders.",
    severity: "good",
    blocks: ["broker execution"],
    allows: ["bridge probe", "account info reads"],
    safetyReason: "Two-layer guard: bridge AND router must both be enabled.",
    related: { label: "Risk Governor", route: "/risk-governor" },
    explanation: "The order router is paused. This is the second of two server-side guards protecting your account.",
    safeNextStep: "Check Risk Governor to understand the guards in place.",
  },
  {
    id: "mt5-deferred",
    label: "MT5 DEFERRED",
    meaning: "MT5 bridge is intentionally not configured yet.",
    severity: "info",
    blocks: ["any MT5-mediated action", "live execution"],
    allows: ["everything demo / simulator"],
    safetyReason: "MT5 stays off until the user sets MT5_BRIDGE_TOKEN and connects the EA.",
    related: { label: "MT5 Bridge", route: "/mt5-bridge" },
    explanation: "ARX is bridge-ready but not bridge-active. Configure the EA + token to enable connection (still won't auto-trade).",
    safeNextStep: "Open MT5 Bridge to read the setup instructions.",
  },
  {
    id: "simulator-mode",
    label: "SIMULATOR MODE",
    meaning: "Strategy scans are running against synthetic candles, not real market data.",
    severity: "info",
    blocks: ["nothing — simulator is informational"],
    allows: ["all sim scans, strategy comparison, replay"],
    safetyReason: "Simulator data is not market data; do not draw money decisions from it.",
    related: { label: "Replay Simulator", route: "/replay-simulator" },
    explanation: "The bot is generating synthetic candles to demonstrate strategy behavior. This is a learning tool, not a market feed.",
    safeNextStep: "Use Replay to test strategies on historical data instead of synthetic.",
  },
  {
    id: "sim-engine",
    label: "SIM ENGINE",
    meaning: "The 5-second simulator scan loop is currently running.",
    severity: "info",
    blocks: ["nothing"],
    allows: ["live signal generation in the dashboard"],
    safetyReason: "Signals are simulated; no orders flow from this loop.",
    related: { label: "Bot Control", route: "/bot-control" },
    explanation: "Every 5 seconds the engine re-scans synthetic candles and emits signals to the dashboard.",
    safeNextStep: "Pause from Bot Control if you want a quiet dashboard.",
  },
  {
    id: "full-tester-access",
    label: "FULL TESTER ACCESS",
    meaning: "Your role grants TESTER-level visibility across the app.",
    severity: "info",
    blocks: ["destructive admin actions"],
    allows: ["bug reporting, knowledge gap viewing, QA pages"],
    safetyReason: "Role checks are server-enforced; the badge is informational.",
    related: { label: "Roles & Permissions", route: "/roles-permissions" },
    explanation: "You can view tester-only diagnostics and submit feedback. Destructive admin actions remain gated.",
    safeNextStep: "Open Roles & Permissions to see exactly what your role allows.",
  },
  {
    id: "fx-symbol",
    label: "FX:EURUSD (or similar)",
    meaning: "The chart and active scan are pinned to this FX symbol.",
    severity: "info",
    blocks: ["nothing"],
    allows: ["focused single-symbol analysis"],
    safetyReason: "Symbol selection has no execution effect in demo mode.",
    related: { label: "Manual Trade Ticket", route: "/manual-trade-ticket" },
    explanation: "Switch the symbol to see different synthetic price action.",
    safeNextStep: "Try other symbols from Manual Trade Ticket.",
  },
  {
    id: "intents",
    label: "N intents",
    meaning: "Number of distinct setup intents the strategy engine has detected this session.",
    severity: "info",
    blocks: ["nothing"],
    allows: ["intent-driven walkthroughs"],
    safetyReason: "Intents are observations, not orders.",
    related: { label: "Strategy Lab", route: "/strategy-lab" },
    explanation: "An intent is a candidate setup the engine flagged. Inspect them in Strategy Lab.",
    safeNextStep: "Open Strategy Lab to review the detected intents.",
  },
  {
    id: "broker-readonly",
    label: "BROKER READ-ONLY",
    meaning: "The broker connection (when present) is read-only — no orders accepted.",
    severity: "good",
    blocks: ["any order send to the broker"],
    allows: ["account info read, positions read, history read"],
    safetyReason: "Read-only is the safe default until the user explicitly enables execution.",
    related: { label: "Broker Read-only", route: "/broker-readonly" },
    explanation: "ARX can see account state but cannot send orders.",
    safeNextStep: "Stay read-only until you have completed the full setup checklist.",
  },
  {
    id: "autopilot-blocked",
    label: "AUTOPILOT BLOCKED",
    meaning: "AI Autopilot will not start because one or more readiness gates are failing.",
    severity: "warn",
    blocks: ["AI Autopilot"],
    allows: ["manual demo trading"],
    safetyReason: "Autopilot requires every readiness gate to be green.",
    related: { label: "AI Autopilot", route: "/ai-autopilot" },
    explanation: "Resolve readiness items before autopilot can start.",
    safeNextStep: "Open Readiness Checklist and clear failing items.",
  },
  {
    id: "readiness",
    label: "READINESS",
    meaning: "Aggregate of all readiness gates required for live operation.",
    severity: "warn",
    blocks: ["live trading", "autopilot", "broker execution"],
    allows: ["demo / simulator at any readiness level"],
    safetyReason: "Readiness gates protect against starting on a broken or untested setup.",
    related: { label: "Readiness Checklist", route: "/readiness-checklist" },
    explanation: "Each red gate has a specific failing reason listed.",
    safeNextStep: "Open the checklist and address gates one at a time.",
  },
  {
    id: "emergency-stop",
    label: "EMERGENCY STOP",
    meaning: "All trading halts immediately when active.",
    severity: "critical",
    blocks: ["everything: demo, sim, live"],
    allows: ["read-only browsing"],
    safetyReason: "The kill switch is the loudest, fastest safety control. The assistant never overrides it.",
    related: { label: "Emergency", route: "/emergency" },
    explanation: "Press Emergency Stop to halt everything; clear it manually when you intend to resume.",
    safeNextStep: "If active, leave it active until you understand why it tripped.",
  },
  {
    id: "heartbeat",
    label: "HEARTBEAT",
    meaning: "Recent ping from the MT5 EA to the API server.",
    severity: "info",
    blocks: ["live execution if missing"],
    allows: ["health visibility"],
    safetyReason: "Missing heartbeat means ARX has no proof the bridge is alive.",
    related: { label: "MT5 Status", route: "/mt5-status" },
    explanation: "EA pings /api/mt5/heartbeat on a schedule with the bridge token.",
    safeNextStep: "Open MT5 Status to confirm the latest heartbeat timestamp.",
  },
  {
    id: "bridge-connected",
    label: "BRIDGE CONNECTED",
    meaning: "The MT5 bridge has a recent valid heartbeat.",
    severity: "good",
    blocks: ["nothing on its own"],
    allows: ["bridge-mediated reads; execution still gated by router"],
    safetyReason: "Connection is necessary but not sufficient for execution.",
    related: { label: "MT5 Bridge", route: "/mt5-bridge" },
    explanation: "Bridge is alive — but the router still controls whether orders flow.",
    safeNextStep: "Continue demo testing; do not enable execution until risk plan is locked.",
  },
  {
    id: "bridge-disconnected",
    label: "BRIDGE DISCONNECTED",
    meaning: "No recent heartbeat — bridge is offline or token mismatched.",
    severity: "warn",
    blocks: ["any bridge-mediated action"],
    allows: ["demo / simulator"],
    safetyReason: "Without heartbeat, the bridge is treated as absent (fail-closed).",
    related: { label: "MT5 Bridge", route: "/mt5-bridge" },
    explanation: "Common causes: EA not running, wrong token, network blocked.",
    safeNextStep: "Open MT5 Bridge and re-check token + EA log.",
  },
];

export function findStatus(idOrLabel: string): StatusEntry | undefined {
  const k = idOrLabel.trim().toUpperCase();
  return STATUS_REGISTRY.find(
    (s) => s.id.toUpperCase() === k || s.label.toUpperCase() === k,
  );
}

/** Return statuses that match the live context (paper/deferred/etc). */
export function activeStatuses(ctx: {
  tradingModeHint?: string;
  mt5Hint?: string;
  safetyStatuses?: string[];
}): StatusEntry[] {
  const explicit = (ctx.safetyStatuses ?? [])
    .map(findStatus)
    .filter((s): s is StatusEntry => !!s);
  const inferred: StatusEntry[] = [];
  if (ctx.tradingModeHint === "paper") {
    const p = findStatus("paper-only");
    if (p && !explicit.includes(p)) inferred.push(p);
  }
  if (ctx.mt5Hint === "deferred") {
    const m = findStatus("mt5-deferred");
    if (m && !explicit.includes(m)) inferred.push(m);
  }
  if (ctx.mt5Hint === "disconnected") {
    const d = findStatus("bridge-disconnected");
    if (d && !explicit.includes(d)) inferred.push(d);
  }
  if (ctx.mt5Hint === "connected") {
    const c = findStatus("bridge-connected");
    if (c && !explicit.includes(c)) inferred.push(c);
  }
  return [...explicit, ...inferred];
}
