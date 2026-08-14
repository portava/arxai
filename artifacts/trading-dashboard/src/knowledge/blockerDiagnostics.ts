/**
 * "Why am I blocked?" diagnostic engine.
 *
 * Inspects live AskContext (badges, MT5 hint, mode hint) and returns a
 * structured list of blockers + a composed Answer. Never tells the user to
 * bypass a lock — only how to resolve setup / readiness properly.
 */
import type { Answer, AskContext } from "./answerEngine";
import { resolveRoute } from "./routeKnowledge";

export type BlockerKind =
  | "paper-only"
  | "live-trading-disabled"
  | "broker-execution-disabled"
  | "mt5-deferred"
  | "simulator-mode"
  | "broker-readonly"
  | "missing-heartbeat"
  | "readiness-failure"
  | "emergency-stop"
  | "permission-level"
  | "incomplete-setup"
  | "missing-secrets"
  | "disconnected-bridge"
  | "autopilot-disabled"
  | "risk-lock";

export interface Blocker {
  kind: BlockerKind;
  what: string;
  why: string;
  causedBy: string;
  protective: boolean;
  openRoute?: { label: string; route: string };
  doNot: string;
}

const CATALOG: Record<BlockerKind, Omit<Blocker, "kind">> = {
  "paper-only": {
    what: "Every order is simulated.",
    why: "ARX boots in Demo Only mode by default — no broker is touched.",
    causedBy: "Default ARX safety posture.",
    protective: true,
    openRoute: { label: "Open Demo Trading", route: "/demo-trading" },
    doNot: "Don't try to disable Demo Only as a workaround for a broker issue.",
  },
  "live-trading-disabled": {
    what: "Live trading actions are disabled.",
    why: "The kill switch is ON and live mode requires the MT5 bridge plus a green readiness checklist.",
    causedBy: "Server-enforced kill switch + readiness gate.",
    protective: true,
    openRoute: { label: "Open Readiness Checklist", route: "/readiness-checklist" },
    doNot: "Don't bypass the kill switch from the client — it has no effect.",
  },
  "broker-execution-disabled": {
    what: "Real broker execution is unavailable.",
    why: "MT5 bridge is not connected, or the guarded order router has not received a green readiness state.",
    causedBy: "MT5 bridge state + guarded order router.",
    protective: true,
    openRoute: { label: "Open MT5 Bridge", route: "/mt5-bridge" },
    doNot: "Don't try to send orders through any non-guarded path.",
  },
  "mt5-deferred": {
    what: "MT5 bridge is intentionally not connected.",
    why: "ARX runs entirely on the simulator until you set MT5_BRIDGE_TOKEN and the EA reports a heartbeat.",
    causedBy: "Missing MT5_BRIDGE_TOKEN secret or no EA heartbeat.",
    protective: true,
    openRoute: { label: "Open MT5 Bridge", route: "/mt5-bridge" },
    doNot: "Don't paste broker credentials anywhere in the app — they're never required by ARX.",
  },
  "simulator-mode": {
    what: "Prices and fills come from the internal simulator.",
    why: "MT5 is deferred, so ARX uses synthetic candles for scanning and fills.",
    causedBy: "MT5 deferred state.",
    protective: true,
    openRoute: { label: "Open Replay Simulator", route: "/replay-simulator" },
    doNot: "Don't treat simulator P&L as broker P&L.",
  },
  "broker-readonly": {
    what: "ARX can read MT5 account state but cannot place orders.",
    why: "Bridge is connected but the guarded order router is in read-only posture.",
    causedBy: "Guarded order router policy.",
    protective: true,
    openRoute: { label: "Open Broker Settings", route: "/broker-readonly" },
    doNot: "Don't try to send orders directly from MT5 to bypass the router.",
  },
  "missing-heartbeat": {
    what: "MT5 heartbeat has not been received.",
    why: "The EA isn't running, or it can't reach the bridge endpoint.",
    causedBy: "EA not started, wrong token, or network/proxy issue.",
    protective: true,
    openRoute: { label: "Open MT5 Status", route: "/mt5-status" },
    doNot: "Don't enable live trading until the heartbeat is green.",
  },
  "readiness-failure": {
    what: "One or more readiness gates is red.",
    why: "Live workflows require every readiness gate green: data feed, simulator, journal, risk, MT5.",
    causedBy: "Specific gate listed on the Readiness Checklist.",
    protective: true,
    openRoute: { label: "Open Readiness Checklist", route: "/readiness-checklist" },
    doNot: "Don't override readiness — fix the failing gate it points to.",
  },
  "emergency-stop": {
    what: "Emergency Stop is engaged.",
    why: "All scanning, intent generation, and order submission are halted by the kill switch.",
    causedBy: "Manual or automatic kill-switch trip.",
    protective: true,
    openRoute: { label: "Open Emergency", route: "/emergency" },
    doNot: "Don't disengage Emergency Stop just to clear it — investigate the trip cause first.",
  },
  "permission-level": {
    what: "Your role doesn't have access to this control.",
    why: "Roles are enforced server-side. The UI may show controls but the server will deny the action.",
    causedBy: "Server role check (OWNER / ADMIN / TESTER).",
    protective: true,
    openRoute: { label: "Open Roles & Permissions", route: "/roles-permissions" },
    doNot: "Don't try to spoof a role from the client — it has no effect.",
  },
  "incomplete-setup": {
    what: "Setup hasn't reached the stage that unlocks this action.",
    why: "Some flows require prior steps (e.g. data import, journal init) before they're available.",
    causedBy: "Setup state / onboarding step.",
    protective: false,
    openRoute: { label: "Open Onboarding", route: "/onboarding" },
    doNot: "Don't skip onboarding gates — they wire the underlying state.",
  },
  "missing-secrets": {
    what: "A required secret/config value isn't set.",
    why: "Bridge / integration features need explicit secrets you control.",
    causedBy: "Missing env (e.g. MT5_BRIDGE_TOKEN).",
    protective: true,
    openRoute: { label: "Open System Health", route: "/system-health" },
    doNot: "Don't hard-code secrets in the app — use the platform secret store.",
  },
  "disconnected-bridge": {
    what: "The MT5 bridge connection is down.",
    why: "Heartbeat hasn't arrived in the last interval, or the EA crashed.",
    causedBy: "EA disconnected or network failure.",
    protective: true,
    openRoute: { label: "Open MT5 Bridge", route: "/mt5-bridge" },
    doNot: "Don't toggle live execution while the bridge is red.",
  },
  "autopilot-disabled": {
    what: "AI Autopilot is blocked.",
    why: "Autopilot needs paper/sim track record, journal entries, and a green risk profile before it's allowed.",
    causedBy: "Autopilot eligibility check.",
    protective: true,
    openRoute: { label: "Open AI Autopilot", route: "/ai-autopilot" },
    doNot: "Don't try to skip autopilot gates — they exist to protect your capital.",
  },
  "risk-lock": {
    what: "Risk Governor has locked further actions.",
    why: "Daily-loss, drawdown, or correlation limits were hit.",
    causedBy: "Risk Governor policy.",
    protective: true,
    openRoute: { label: "Open Risk Governor", route: "/risk-governor" },
    doNot: "Don't widen risk limits to escape a risk lock — review what triggered it first.",
  },
};

export function diagnoseBlockers(ctx: AskContext): Blocker[] {
  const blockers: Blocker[] = [];
  const badges = (ctx.safetyStatuses ?? []).map((b) => b.toUpperCase());
  const has = (token: string) => badges.some((b) => b.includes(token));

  // Always-on baseline locks while ARX is in tester mode.
  blockers.push({ kind: "live-trading-disabled", ...CATALOG["live-trading-disabled"] });
  blockers.push({ kind: "broker-execution-disabled", ...CATALOG["broker-execution-disabled"] });

  if (ctx.tradingModeHint === "paper" || has("PAPER")) {
    blockers.push({ kind: "paper-only", ...CATALOG["paper-only"] });
  }
  if (ctx.mt5Hint === "deferred" || has("DEFERRED")) {
    blockers.push({ kind: "mt5-deferred", ...CATALOG["mt5-deferred"] });
    blockers.push({ kind: "simulator-mode", ...CATALOG["simulator-mode"] });
  }
  if (ctx.mt5Hint === "disconnected") {
    blockers.push({ kind: "disconnected-bridge", ...CATALOG["disconnected-bridge"] });
    blockers.push({ kind: "missing-heartbeat", ...CATALOG["missing-heartbeat"] });
  }
  if (ctx.tradingModeHint === "broker-readonly") {
    blockers.push({ kind: "broker-readonly", ...CATALOG["broker-readonly"] });
  }

  return blockers;
}

export function blockersToAnswer(ctx: AskContext): Answer {
  const list = diagnoseBlockers(ctx);
  const top = list.slice(0, 5);
  const lines = top.map((b) => `• ${b.what} — ${b.why}`).join("\n");
  const related = top
    .map((b) => b.openRoute)
    .filter((r): r is { label: string; route: string } => !!r)
    .filter((r) => !!resolveRoute(r.route)) // route-validate at composition boundary
    .filter((r, i, a) => a.findIndex((x) => x.route === r.route) === i)
    .slice(0, 5);

  return {
    answer:
      `Here's what's blocking actions on this page right now (route: ${ctx.route}):\n\n${lines}\n\nLive trading remains unavailable until MT5 is connected and every readiness gate is green. None of these are errors — they're protective.`,
    detail:
      "What NOT to do:\n" + top.map((b) => `• ${b.doNot}`).join("\n"),
    safety:
      "I never recommend bypassing a safety lock. Resolve setup / readiness instead.",
    sourceId: "blockers:composed",
    matchType: "kb",
    confidence: 0.95,
    related,
    nextAction: related[0],
  };
}
