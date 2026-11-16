/**
 * UI Element Registry — source of truth for visible app controls.
 *
 * Each entry teaches the assistant about one concrete element so it can
 * answer "What is this?", "What does it do?", "Why is it disabled?",
 * "Where do I go from here?". Entries are matched by id, label, or alias.
 *
 * IMPORTANT
 * - Adding a new element here is the only place needed for assistant
 *   support — no other module hard-codes element strings.
 * - Routes referenced from `relatedRoute` are validated by the QA test
 *   `_qa-test.ts` against `routeKnowledge.ts`.
 * - This file MUST NOT contain trade-execution copy or anything that
 *   instructs the user to bypass safety locks.
 */
export type UiElementKind =
  | "button" | "badge" | "tab" | "card" | "input" | "menu-item"
  | "safety-lock" | "status" | "route-link";

export interface UiElement {
  /** Stable id used in `data-arx-id` attributes. */
  id: string;
  label: string;
  aliases?: string[];
  type: UiElementKind;
  /** Route(s) where this element appears. "*" === everywhere. */
  pages: string[];
  /** Optional related canonical route the assistant can offer. */
  relatedRoute?: string;
  explanation: string;
  whatItDoes: string;
  whatItDoesNot: string;
  requiredPermissions?: string[];
  /** Common disabled / blocker reasons (plain English). */
  disabledReasons?: string[];
  safetyNote?: string;
  /** Sample questions this element can answer for the assistant. */
  sampleQuestions?: string[];
  safeNextAction: string;
}

export const UI_ELEMENTS: UiElement[] = [
  // ── Status badges ──────────────────────────────────────────────────────
  {
    id: "badge-demo-mode", label: "DEMO", aliases: ["demo", "demo mode"],
    type: "badge", pages: ["*"], relatedRoute: "/demo-trading",
    explanation: "Trades route to your per-user MT5 demo account when armed.",
    whatItDoes: "Routes every trade to the demo broker; no live order is sent.",
    whatItDoesNot: "It does not place real money trades.",
    safetyNote: "Demo mode is the safe default and requires VERIFIED_DEMO + armed.",
    sampleQuestions: ["What does Demo mode mean?", "Is this real money?"],
    safeNextAction: "Open Demo Trading to review your demo execution controls.",
  },
  {
    id: "badge-live-trading-disabled", label: "LIVE TRADING DISABLED", aliases: ["live disabled", "live off"],
    type: "badge", pages: ["*"], relatedRoute: "/readiness-checklist",
    explanation: "Server-enforced lock that blocks every live trading code path — keeps ARX in demo mode until the MT5 bridge and kill switch are intentionally cleared.",
    whatItDoes: "Returns 503 / refusal at the API for any live execution endpoint.",
    whatItDoesNot: "Cannot be toggled by the assistant or by client code.",
    safetyNote: "Lock is enforced server-side; client UI cannot bypass it.",
    sampleQuestions: ["Why is live trading disabled?", "Can I turn live trading on?"],
    safeNextAction: "Use demo / simulator while you finish the readiness checklist.",
  },
  {
    id: "badge-live-broker-execution-disabled", label: "LIVE BROKER EXECUTION DISABLED",
    aliases: ["broker execution disabled", "router off"],
    type: "badge", pages: ["*"], relatedRoute: "/risk-governor",
    explanation: "Order router will not forward orders even if the bridge is up.",
    whatItDoes: "Second of two server-side guards protecting your account.",
    whatItDoesNot: "Does not affect demo / simulator flows.",
    safetyNote: "Two-layer guard: bridge AND router must both be enabled.",
    safeNextAction: "Read Risk Governor for the active rules.",
  },
  {
    id: "badge-mt5-deferred", label: "MT5 DEFERRED", aliases: ["mt5 off", "bridge deferred"],
    type: "badge", pages: ["*"], relatedRoute: "/mt5-bridge",
    explanation: "MT5 bridge is intentionally not configured.",
    whatItDoes: "Tells you ARX is bridge-ready but not bridge-active.",
    whatItDoesNot: "Does not connect to a broker by itself.",
    safetyNote: "Bridge stays off until you create a per-user bridge token on MT5 Setup and connect the EA.",
    sampleQuestions: ["What does MT5 Deferred mean?", "How do I connect MT5?"],
    safeNextAction: "Open MT5 Bridge to read the connection steps.",
  },
  {
    id: "badge-simulator-mode", label: "SIMULATOR MODE", aliases: ["sim mode"],
    type: "badge", pages: ["*"], relatedRoute: "/replay-simulator",
    explanation: "Strategy scans run against synthetic candles, not market data.",
    whatItDoes: "Demonstrates strategy behavior without a real feed.",
    whatItDoesNot: "Does not represent live market conditions.",
    safetyNote: "Do not draw money decisions from simulator results.",
    safeNextAction: "Use Replay against historical data to validate ideas.",
  },
  {
    id: "badge-sim-engine", label: "SIM ENGINE", aliases: ["engine running"],
    type: "badge", pages: ["*"], relatedRoute: "/bot-control",
    explanation: "The 5-second simulator scan loop is currently running.",
    whatItDoes: "Re-scans synthetic candles and emits signals every 5s.",
    whatItDoesNot: "Does not place orders.",
    safeNextAction: "Pause from Bot Control if you want a quiet dashboard.",
  },
  {
    id: "badge-fx-eurusd", label: "FX:EURUSD", aliases: ["fx symbol", "current symbol"],
    type: "badge", pages: ["*"], relatedRoute: "/manual-trade-ticket",
    explanation: "The chart and active scan are pinned to this FX symbol.",
    whatItDoes: "Filters scans + chart to one symbol.",
    whatItDoesNot: "Has no execution effect in demo mode.",
    safeNextAction: "Switch the symbol from Manual Trade Ticket.",
  },
  {
    id: "badge-intents", label: "INTENTS", aliases: ["33 intents", "intent count"],
    type: "badge", pages: ["*"], relatedRoute: "/strategy-lab",
    explanation: "Number of distinct setup intents the engine has detected this session.",
    whatItDoes: "Reflects how many candidate setups the engine has flagged.",
    whatItDoesNot: "It is not a count of orders or positions.",
    sampleQuestions: ["What does 33 intents mean?", "What is the intents badge?"],
    safeNextAction: "Open Strategy Lab to inspect each intent.",
  },
  {
    id: "badge-full-tester-access", label: "FULL TESTER ACCESS", aliases: ["tester badge", "tester role"],
    type: "badge", pages: ["*"], relatedRoute: "/roles-permissions",
    explanation: "Your role grants TESTER-level visibility across the app.",
    whatItDoes: "Unlocks tester-only diagnostics and feedback views.",
    whatItDoesNot: "Does not unlock destructive admin actions.",
    safeNextAction: "Open Roles & Permissions to see exactly what the role allows.",
  },
  {
    id: "badge-broker-readonly", label: "BROKER READ-ONLY", aliases: ["read-only broker"],
    type: "badge", pages: ["*"], relatedRoute: "/broker-readonly",
    explanation: "Broker connection (when present) accepts no orders.",
    whatItDoes: "Allows account / positions / history reads only.",
    whatItDoesNot: "Cannot send any order regardless of UI state.",
    safetyNote: "Read-only is the safe default until execution is intentionally enabled.",
    safeNextAction: "Stay read-only until the full setup checklist is complete.",
  },
  {
    id: "badge-autopilot-blocked", label: "AUTOPILOT BLOCKED", aliases: ["autopilot off"],
    type: "badge", pages: ["*"], relatedRoute: "/ai-autopilot",
    explanation: "AI Autopilot will not start because readiness gates are failing.",
    whatItDoes: "Communicates that autopilot is gated.",
    whatItDoesNot: "Does not block manual demo trading.",
    safeNextAction: "Open Readiness Checklist and clear failing gates.",
  },
  {
    id: "badge-readiness", label: "READINESS",
    type: "badge", pages: ["*"], relatedRoute: "/readiness-checklist",
    explanation: "Aggregate of all readiness gates required for live operation.",
    whatItDoes: "Surfaces overall readiness state at a glance.",
    whatItDoesNot: "Does not bypass any individual gate.",
    safeNextAction: "Open the checklist to fix red gates one at a time.",
  },
  {
    id: "badge-emergency-stop", label: "EMERGENCY STOP", aliases: ["kill switch"],
    type: "safety-lock", pages: ["*"], relatedRoute: "/emergency",
    explanation: "Halts demo, sim, and any live flow immediately when active.",
    whatItDoes: "Server-side hard stop. Always wins.",
    whatItDoesNot: "Does not auto-clear — must be cleared manually.",
    safetyNote: "Never override Emergency Stop from the assistant.",
    sampleQuestions: ["What does Emergency Stop do?"],
    safeNextAction: "If active, leave it on until you understand why it tripped.",
  },
  {
    id: "badge-heartbeat", label: "HEARTBEAT",
    type: "badge", pages: ["*"], relatedRoute: "/mt5-status",
    explanation: "Recent ping from the MT5 EA to the API server.",
    whatItDoes: "Proves the bridge is alive with the right token.",
    whatItDoesNot: "Does not authorize execution by itself.",
    safeNextAction: "Open MT5 Status to confirm the latest heartbeat timestamp.",
  },
  {
    id: "badge-bridge-connected", label: "BRIDGE CONNECTED",
    type: "badge", pages: ["*"], relatedRoute: "/mt5-bridge",
    explanation: "MT5 bridge has a recent valid heartbeat.",
    whatItDoes: "Allows bridge-mediated reads.",
    whatItDoesNot: "Does not enable order send — router still gates execution.",
    safeNextAction: "Continue demo testing until risk plan is locked.",
  },
  {
    id: "badge-bridge-disconnected", label: "BRIDGE DISCONNECTED",
    type: "badge", pages: ["*"], relatedRoute: "/mt5-bridge",
    explanation: "No recent heartbeat — bridge is offline or token mismatched.",
    whatItDoes: "Tells you any bridge action will fail until restored.",
    whatItDoesNot: "Does not affect demo / simulator.",
    disabledReasons: ["EA not running", "wrong or revoked per-user bridge token", "network blocked"],
    safeNextAction: "Open MT5 Bridge and re-check token + EA log.",
  },

  // ── Bottom nav tabs ────────────────────────────────────────────────────
  {
    id: "nav-cockpit", label: "Cockpit", aliases: ["dashboard", "home"],
    type: "tab", pages: ["*"], relatedRoute: "/",
    explanation: "Primary dashboard with balance, P&L, win rate, drawdown, signals.",
    whatItDoes: "Lands you on the at-a-glance cockpit view.",
    whatItDoesNot: "Does not place trades.",
    safeNextAction: "Use Cockpit as your first stop each session.",
  },
  {
    id: "nav-trade", label: "Trade", aliases: ["trade tab", "trade command"],
    type: "tab", pages: ["*"], relatedRoute: "/trade-command-room",
    explanation: "Trade Command Room — manual ticket, positions, scanner shortcuts.",
    whatItDoes: "Opens the trading workspace.",
    whatItDoesNot: "Does not auto-execute. Demo-only by default.",
    safeNextAction: "Open Trade and review controls before any action.",
  },
  {
    id: "nav-ai", label: "AI", aliases: ["ai tab", "scanner"],
    type: "tab", pages: ["*"], relatedRoute: "/market-scanner",
    explanation: "AI Scanner / Coach surface for signals and post-trade feedback.",
    whatItDoes: "Opens the AI workspace.",
    whatItDoesNot: "Does not place trades.",
    safeNextAction: "Browse signals; use AI Coach for debriefs.",
  },
  {
    id: "nav-risk", label: "Risk", aliases: ["risk tab", "risk command"],
    type: "tab", pages: ["*"], relatedRoute: "/risk-command-center",
    explanation: "Risk Command Center — caps, governor rules, kill switch access.",
    whatItDoes: "Opens the risk control surface.",
    whatItDoesNot: "Does not bypass any rule.",
    safetyNote: "Risk rules are server-enforced; UI changes alone do not weaken them.",
    safeNextAction: "Review every active rule before any trade.",
  },
  {
    id: "nav-more", label: "More", aliases: ["more tab", "menu"],
    type: "tab", pages: ["*"], relatedRoute: "/admin/data-management",
    explanation: "Drawer to admin / data / settings pages.",
    whatItDoes: "Opens the More menu.",
    whatItDoesNot: "Does not change app state by itself.",
    safeNextAction: "Open More to reach data, admin, and settings pages.",
  },

  // ── Help & assistant controls ──────────────────────────────────────────
  {
    id: "help-action-ask", label: "Ask a question", aliases: ["ask anything"],
    type: "input", pages: ["*"], relatedRoute: "/help",
    explanation: "Free-text input that routes to the answer engine.",
    whatItDoes: "Classifies your message into navigate / explain / refuse / answer.",
    whatItDoesNot: "Does not place trades or change settings.",
    safeNextAction: 'Try "Explain this screen" or "Why am I blocked?"',
  },
  {
    id: "help-action-guide", label: "ARX Guide", aliases: ["guide tab", "open guide"],
    type: "menu-item", pages: ["*"], relatedRoute: "/help",
    explanation: "Opens the in-widget Guide showing safest next step + checklist + active statuses.",
    whatItDoes: "Composes a one-screen briefing for the current state.",
    whatItDoesNot: "Does not change app state.",
    safeNextAction: "Open ARX Guide to see your safest next step.",
  },
  {
    id: "help-action-walkthroughs", label: "Guided walkthroughs",
    type: "menu-item", pages: ["*"], relatedRoute: "/help",
    explanation: "List of step-by-step flows with checkable steps and Open-page links.",
    whatItDoes: "Lets you pick a walkthrough to follow.",
    whatItDoesNot: "Does not auto-complete steps for you.",
    safeNextAction: "Pick a walkthrough that matches your goal.",
  },
  {
    id: "help-action-tour", label: "Start app tour",
    type: "menu-item", pages: ["*"], relatedRoute: "/help",
    explanation: "Re-launches the first-run onboarding tour.",
    whatItDoes: "Replays the orientation overlay.",
    whatItDoesNot: "Does not change saved settings.",
    safeNextAction: "Run the tour if anything feels unfamiliar.",
  },
  {
    id: "help-action-center", label: "Open Help Center", aliases: ["open full help center"],
    type: "route-link", pages: ["*"], relatedRoute: "/help",
    explanation: "Navigates to the full Help Center page.",
    whatItDoes: "Opens /help with the full library.",
    whatItDoesNot: "Does not change settings.",
    safeNextAction: "Open Help Center for the full playbook.",
  },
  {
    id: "help-action-report", label: "Report an issue", aliases: ["report issue", "feedback"],
    type: "menu-item", pages: ["*"], relatedRoute: "/feedback-center",
    explanation: "Opens the report form within the assistant.",
    whatItDoes: "Sends your report to /api/feedback.",
    whatItDoesNot: "Does not collect tokens or secrets.",
    safeNextAction: "Use this whenever something behaves unexpectedly.",
  },
  {
    id: "floating-help-trigger", label: "ARX Assistant button",
    type: "button", pages: ["*"], relatedRoute: "/help",
    explanation: "Round floating button (bottom-right) that opens the assistant.",
    whatItDoes: "Toggles the floating assistant panel.",
    whatItDoesNot: "Does not change app state.",
    safeNextAction: "Tap whenever you need help on a page.",
  },
  {
    id: "floating-help-close", label: "ARX Assistant close button",
    type: "button", pages: ["*"], relatedRoute: "/help",
    explanation: "Closes the floating assistant panel.",
    whatItDoes: "Hides the panel and remembers state until next open.",
    whatItDoesNot: "Does not clear in-memory follow-up context.",
    safeNextAction: "Close anytime — your draft is not sent.",
  },
  {
    id: "help-ask-back", label: "ARX Assistant back button",
    type: "button", pages: ["*"], relatedRoute: "/help",
    explanation: "Returns to the assistant menu.",
    whatItDoes: "Switches the panel view back to the menu.",
    whatItDoesNot: "Does not erase your chat history within this session.",
    safeNextAction: "Back to menu, then pick a different action.",
  },

  // ── Diagnostic chips ───────────────────────────────────────────────────
  {
    id: "chip-why-blocked", label: "Why am I blocked?",
    type: "menu-item", pages: ["*"], relatedRoute: "/readiness-checklist",
    explanation: "Runs blocker diagnostics for the current page + safety state.",
    whatItDoes: "Lists every active blocker with a why-and-fix.",
    whatItDoesNot: "Does not bypass any blocker.",
    safeNextAction: "Address blockers in the order they appear.",
  },
  {
    id: "chip-safest-next", label: "What is the safest next step?",
    type: "menu-item", pages: ["*"], relatedRoute: "/help",
    explanation: "Returns the priority-ranked safest next action for the current state.",
    whatItDoes: "Picks one safe next step + why + what NOT to do.",
    whatItDoesNot: "Never recommends enabling live trading.",
    safetyNote: "liveStillUnavailable is always true.",
    safeNextAction: "Follow the recommended step.",
  },
  {
    id: "link-readiness", label: "Readiness",
    type: "route-link", pages: ["*"], relatedRoute: "/readiness-checklist",
    explanation: "Opens the readiness checklist.",
    whatItDoes: "Lists every readiness gate with current state.",
    whatItDoesNot: "Does not skip any gate.",
    safeNextAction: "Clear gates one at a time.",
  },
  {
    id: "link-coach", label: "AI Coach",
    type: "route-link", pages: ["*"], relatedRoute: "/ai-coach",
    explanation: "Post-trade coaching surface.",
    whatItDoes: "Generates feedback on recent demo trades.",
    whatItDoesNot: "Does not place trades.",
    safeNextAction: "Run a debrief after a demo session.",
  },
  {
    id: "link-replay", label: "Replay",
    type: "route-link", pages: ["*"], relatedRoute: "/replay-simulator",
    explanation: "Replays historical candles to test strategies.",
    whatItDoes: "Lets you compare strategy behavior on past data.",
    whatItDoesNot: "Does not represent live market conditions.",
    safeNextAction: "Use Replay before relying on a strategy.",
  },
  {
    id: "link-data", label: "Data", aliases: ["my data"],
    type: "route-link", pages: ["*"], relatedRoute: "/data-import",
    explanation: "Data import + quality view.",
    whatItDoes: "Lets you import CSV candle data.",
    whatItDoesNot: "Does not auto-clean malformed data silently.",
    safeNextAction: "Inspect any failing rows before import.",
  },
  {
    id: "link-mt5-bridge", label: "MT5 Bridge",
    type: "route-link", pages: ["*"], relatedRoute: "/mt5-bridge",
    explanation: "Setup + status for the MT5 bridge.",
    whatItDoes: "Shows bridge config requirements.",
    whatItDoesNot: "Does not connect by itself.",
    safetyNote: "Bridge stays off until you create a per-user bridge token on MT5 Setup.",
    safeNextAction: "Read EA setup steps before configuring.",
  },
  {
    id: "link-broker-settings", label: "Broker Settings", aliases: ["broker setup"],
    type: "route-link", pages: ["*"], relatedRoute: "/broker-readonly",
    explanation: "Broker connection state (read-only by default).",
    whatItDoes: "Reports connection state and account info.",
    whatItDoesNot: "Does not enable order send.",
    safeNextAction: "Confirm read-only state before any trade.",
  },
];

export interface ElementMatch { element: UiElement; confidence: number; via: "id" | "label" | "alias" | "page" | "fuzzy" }

/** Find a UI element by free-text query, optionally biased to current route. */
export function findElement(query: string, currentRoute?: string): ElementMatch | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  // 1) exact id
  const byId = UI_ELEMENTS.find((e) => e.id === q);
  if (byId) return { element: byId, confidence: 1, via: "id" };
  // 2) exact label (case-insensitive)
  const byLabel = UI_ELEMENTS.find((e) => e.label.toLowerCase() === q);
  if (byLabel) return { element: byLabel, confidence: 0.95, via: "label" };
  // 3) alias
  const byAlias = UI_ELEMENTS.find((e) => (e.aliases ?? []).some((a) => a.toLowerCase() === q));
  if (byAlias) return { element: byAlias, confidence: 0.9, via: "alias" };
  // 4) substring scoring with route bias
  const scored = UI_ELEMENTS.map((e) => {
    let score = 0;
    if (e.label.toLowerCase().includes(q)) score += 5;
    if ((e.aliases ?? []).some((a) => q.includes(a.toLowerCase()) || a.toLowerCase().includes(q))) score += 4;
    if (q.includes(e.label.toLowerCase())) score += 6;
    if (currentRoute && (e.pages.includes(currentRoute) || e.pages.includes("*"))) score += 0.5;
    return { e, score };
  })
    .filter((r) => r.score >= 4)
    .sort((a, b) => b.score - a.score);
  if (scored.length === 0) return undefined;
  return { element: scored[0].e, confidence: Math.min(1, scored[0].score / 12), via: "fuzzy" };
}

export function elementsForPage(routePath: string): UiElement[] {
  return UI_ELEMENTS.filter((e) => e.pages.includes("*") || e.pages.includes(routePath));
}

export function badgeElements(): UiElement[] {
  return UI_ELEMENTS.filter((e) => e.type === "badge" || e.type === "safety-lock");
}
