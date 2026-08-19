/**
 * Guided assistant walkthroughs — short ordered flows for the 15 most common
 * tasks. Each step references real ARX routes only.
 */
import { resolveRoute } from "./routeKnowledge";

export interface WalkthroughStep {
  title: string;
  body: string;
  route?: string;
  warning?: string;
}

export interface Walkthrough {
  id: string;
  title: string;
  intro: string;
  steps: WalkthroughStep[];
  completion: string;
}

export const WALKTHROUGHS: Walkthrough[] = [
  {
    id: "wt-understand-arx",
    title: "Understanding ARX AI",
    intro: "ARX is a paper-first AI trading command center: Analyze the market, manage Risk, eXecute trades only when every safety gate is green.",
    steps: [
      { title: "Read the brand", body: "ARX = Analyze · Risk · eXecute. Every screen reflects one of those three." },
      { title: "Open the Cockpit", body: "Your dashboard with account state and signals.", route: "/" },
      { title: "Tour the Help Center", body: "All app docs live here.", route: "/help" },
    ],
    completion: "You can describe ARX in one sentence and find any page from the sidebar or More menu.",
  },
  {
    id: "wt-read-badges",
    title: "Reading status badges",
    intro: "The top safety bar shows everything ARX is doing to protect you.",
    steps: [
      { title: "FULL TESTER ACCESS", body: "Tester role is active — UI shows all controls, server enforces real permissions." },
      { title: "LIVE BROKER EXECUTION DISABLED", body: "No real orders can be sent." },
      { title: "MT5 DEFERRED · SIMULATOR MODE", body: "Bridge is intentionally off; prices come from the simulator." },
      { title: "FX:EURUSD", body: "The currently selected chart symbol." },
      { title: "INTENTS", body: "Number of AI-flagged trade ideas waiting for review (none are sent to a broker)." },
    ],
    completion: "You can read every badge without guessing.",
  },
  {
    id: "wt-paper-session",
    title: "Starting a demo session",
    intro: "Demo sessions are the safe way to practice — every fill is simulated.",
    steps: [
      { title: "Check Readiness", body: "Confirm the readiness checklist is green.", route: "/readiness-checklist" },
      { title: "Open Demo Trading", body: "Use the Demo Trading page to start a session.", route: "/demo-trading" },
      { title: "Set risk", body: "Confirm lot size, max loss, and stop policy on Risk Settings.", route: "/risk-settings" },
      { title: "Start the session", body: "Press Start. P&L is simulated only." },
    ],
    completion: "An active demo session shows under Active Demo Session.",
  },
  {
    id: "wt-simulator-mode",
    title: "Understanding simulator mode",
    intro: "Simulator mode replaces broker prices with internal synthetic candles so you can practice strategy and risk without a broker.",
    steps: [
      { title: "Why it exists", body: "MT5 is deferred until you connect it; the simulator keeps the app fully functional in the meantime." },
      { title: "What's simulated", body: "Prices, fills, P&L. No order ever leaves ARX." },
      { title: "When to switch off", body: "Only after MT5 is connected, heartbeat is green, and readiness passes." },
    ],
    completion: "You can explain simulator mode to another tester in 30 seconds.",
  },
  {
    id: "wt-connect-mt5",
    title: "Connecting MT5 safely",
    intro: "MT5 connects via a small Expert Advisor that talks to the ARX bridge.",
    steps: [
      { title: "Set the secret", body: "Set MT5_BRIDGE_TOKEN as a platform secret.", warning: "Never paste broker credentials into the app." },
      { title: "Install the EA", body: "Install the ARX EA from the MT5 Bridge page.", route: "/mt5-bridge" },
      { title: "Wait for heartbeat", body: "Open MT5 Status; the heartbeat must turn green.", route: "/mt5-status" },
      { title: "Confirm read-only first", body: "ARX stays in read-only posture until you explicitly enable execution." },
    ],
    completion: "MT5 heartbeat is green and ARX shows the broker as connected (read-only).",
  },
  {
    id: "wt-heartbeat",
    title: "Checking heartbeat",
    intro: "Heartbeat is the EA's regular ping that proves the bridge is alive.",
    steps: [
      { title: "Open MT5 Status", body: "View the most recent heartbeat timestamp.", route: "/mt5-status" },
      { title: "Confirm interval", body: "A green heartbeat arrives at the configured interval (typically every few seconds)." },
      { title: "Diagnose missing heartbeat", body: "EA stopped, wrong token, or proxy/network issue. None of these enable live trading on their own." },
    ],
    completion: "You can spot heartbeat trouble in under 5 seconds.",
  },
  {
    id: "wt-why-live-disabled",
    title: "Why live trading is disabled",
    intro: "Live trading is intentionally off. Multiple gates must agree before any real order can be sent.",
    steps: [
      { title: "Kill switch ON", body: "Server-enforced; client cannot toggle." },
      { title: "MT5 bridge required", body: "Without bridge + heartbeat, no execution path exists." },
      { title: "Readiness gates", body: "Every readiness gate must be green.", route: "/readiness-checklist" },
      { title: "Guarded order router", body: "All orders pass through the guarded router; mock or paper paths cannot be promoted." },
    ],
    completion: "You can name three reasons live trading is disabled without checking docs.",
  },
  {
    id: "wt-readiness",
    title: "Reviewing readiness",
    intro: "Readiness is ARX's pre-flight check.",
    steps: [
      { title: "Open Readiness", body: "Each gate shows green/red and what to fix.", route: "/readiness-checklist" },
      { title: "Resolve the failing gate", body: "Click the gate for its detail page (data feed, journal, risk, MT5)." },
      { title: "Re-run", body: "Re-check after fixing — ARX re-evaluates automatically." },
    ],
    completion: "All readiness gates are green or you know exactly which one isn't.",
  },
  {
    id: "wt-risk",
    title: "Using the Risk page",
    intro: "Risk Governor is the account-protection layer.",
    steps: [
      { title: "Open Risk Governor", body: "View daily loss, drawdown, exposure, and correlation.", route: "/risk-governor" },
      { title: "Tune Risk Settings", body: "Set max loss, lot size, and stop policy.", route: "/risk-settings" },
      { title: "Watch the Command Center", body: "Real-time risk posture lives here.", route: "/risk-command-center" },
    ],
    completion: "You can answer 'what is my max loss today?' in one click.",
  },
  {
    id: "wt-replay",
    title: "Using Replay",
    intro: "Replay lets you re-run market scenarios through ARX strategies.",
    steps: [
      { title: "Open Replay Simulator", body: "Pick a recorded market window.", route: "/replay-simulator" },
      { title: "Run the replay", body: "Watch how the strategy + risk would have behaved." },
      { title: "Review the debrief", body: "Open the post-trade debrief for AI-generated lessons.", route: "/post-trade-debriefs" },
    ],
    completion: "You've completed at least one replay and read its debrief.",
  },
  {
    id: "wt-coach",
    title: "Using Coach",
    intro: "AI Coach reviews your journal and discipline metrics and gives specific feedback.",
    steps: [
      { title: "Open AI Coach", body: "Read the latest coaching note.", route: "/ai-coach" },
      { title: "Open Journal", body: "Make sure your journal entries are up to date.", route: "/journal" },
      { title: "Apply one suggestion", body: "Coach feedback is most useful when you act on a single item per session." },
    ],
    completion: "You've received and applied at least one coaching note.",
  },
  {
    id: "wt-emergency",
    title: "Understanding Emergency Stop",
    intro: "The big red lever. Halts scanning, intents, and order submission system-wide.",
    steps: [
      { title: "Find Emergency Stop", body: "It lives in the sidebar and on its dedicated page.", route: "/emergency" },
      { title: "When to use it", body: "Anything unexpected — runaway behaviour, unfamiliar account state, or simply ending a session." },
      { title: "What it does NOT do", body: "It does not close existing broker positions on its own; it stops ARX from acting." },
    ],
    completion: "You can engage Emergency Stop within 2 seconds and explain its scope.",
  },
  {
    id: "wt-more",
    title: "Finding hidden routes under More",
    intro: "The More menu collects pages that don't fit on the bottom nav.",
    steps: [
      { title: "Open More", body: "Tap More on the bottom nav.", route: "/" },
      { title: "Find broker setup", body: "Broker readonly + MT5 Bridge live here.", route: "/mt5-bridge" },
      { title: "Find replay & data", body: "Replay simulator and data import are under More.", route: "/replay-simulator" },
      { title: "Find emergency", body: "Emergency Stop info is also under More.", route: "/emergency" },
    ],
    completion: "You can reach any feature page in two taps.",
  },
  {
    id: "wt-report-issue",
    title: "Reporting an issue",
    intro: "ARX has a built-in issue reporter. Use it for bugs, weird behaviour, or knowledge gaps.",
    steps: [
      { title: "Open the assistant", body: "Tap the AI Help pill (bottom right)." },
      { title: "Pick 'Report an issue'", body: "Fill in title, category, severity, and what happened." },
      { title: "Submit", body: "The issue lands in the Feedback Center for the team.", route: "/feedback-center" },
    ],
    completion: "Your issue appears in the Feedback Center with a feedback id.",
  },
  {
    id: "wt-first-time",
    title: "Safest first-time setup path",
    intro: "Follow this order on day one and you'll never trip a safety gate.",
    steps: [
      { title: "Onboarding", body: "Complete the onboarding tour first.", route: "/onboarding" },
      { title: "Read badges", body: "Make sure you can name every visible badge." },
      { title: "Run readiness", body: "Open the readiness checklist; fix anything red.", route: "/readiness-checklist" },
      { title: "Start a demo session", body: "Practice in Demo Trading.", route: "/demo-trading" },
      { title: "Run a replay", body: "See how a recorded scenario plays out.", route: "/replay-simulator" },
      { title: "Open Coach + Journal", body: "Start your discipline loop.", route: "/ai-coach" },
      { title: "(Later) Connect MT5", body: "Only when you're ready — read 'Connecting MT5 safely' first." },
    ],
    completion: "You're demo-trading with a green readiness state and Coach is giving feedback.",
  },
  {
    id: "wt-show-me-around",
    title: "Show me around ARX",
    intro: "Quick guided tour of the major ARX surfaces — one area at a time. Nothing on this tour can place a trade or change live state.",
    steps: [
      { title: "Cockpit", body: "Your overview: balance, P&L, win rate, drawdown, latest signals.", route: "/" },
      { title: "Trade", body: "Trade Command Room — manual ticket and positions. Demo-only.", route: "/trade-command-room" },
      { title: "AI", body: "AI Command Center — coach, mentor, and analytics.", route: "/ai-command-center" },
      { title: "Risk", body: "Risk Command Center — caps, governor rules, kill-switch access.", route: "/risk-command-center" },
      { title: "Help Center", body: "All app docs, the assistant, and feedback live here.", route: "/help" },
      { title: "Status badges", body: "The top bar shows everything ARX is doing to protect you (DEMO ONLY, LIVE TRADING DISABLED, MT5 DEFERRED, etc.)." },
      { title: "Emergency Stop", body: "Hard halt for demo, sim, and any live flow. Always wins.", route: "/emergency" },
      { title: "MT5 / Bridge", body: "Optional connector to MetaTrader 5. Off by default.", route: "/mt5-bridge" },
      { title: "Demo / Simulator", body: "Default modes — synthetic candles or demo broker, never live broker orders.", route: "/demo-trading" },
      { title: "Readiness", body: "Aggregate of every gate that must be green before live is even considered.", route: "/readiness-checklist" },
      { title: "Reporting issues", body: "Submit feedback so missing knowledge can be added.", route: "/feedback-center" },
    ],
    completion: "You've seen every major ARX surface and know the safety boundaries.",
  },
];

/** True if the walkthrough's referenced routes all exist. */
export function validateWalkthrough(w: Walkthrough): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const s of w.steps) {
    if (s.route && !resolveRoute(s.route)) missing.push(s.route);
  }
  return { ok: missing.length === 0, missing };
}
