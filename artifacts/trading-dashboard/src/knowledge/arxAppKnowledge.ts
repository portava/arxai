/**
 * ARX App Brain — central knowledge base.
 *
 * This file is the single source of truth for the in-app ARX Assistant.
 * It is consumed by `answerEngine.ts` and rendered by `FloatingHelpWidget`.
 *
 * Hard rules baked into every entry:
 *   - Never recommend live trades or specific buy/sell actions.
 *   - Never bypass safety locks or claim live trading is "safe".
 *   - Never reveal secrets / tokens / broker credentials.
 *   - Always prefer paper / simulator / replay over live.
 */

export interface KnowledgeEntry {
  id: string;
  title: string;
  category:
    | "OVERVIEW"
    | "BADGE"
    | "SAFETY"
    | "MT5"
    | "DEMO"
    | "LIVE"
    | "RISK"
    | "NAV"
    | "TROUBLE"
    | "PERMISSION"
    | "FEATURE";
  /** Short user-facing answer. Plain language, no jargon, no advice. */
  answer: string;
  /** Optional follow-up explanation, ~2 paragraphs max. */
  detail?: string;
  /** Optional safety reminder — shown as a "Safety" callout. */
  safety?: string;
  /** Optional related routes the user can jump to. */
  related?: { label: string; route: string }[];
  /** Search keywords/aliases. Lowercase, no punctuation. */
  keywords: string[];
  /** Optional quick-question chip text to surface in the UI. */
  chip?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. APP OVERVIEW
// ─────────────────────────────────────────────────────────────────────────────
const overview: KnowledgeEntry[] = [
  {
    id: "what-is-arx",
    title: "What is ARX AI?",
    category: "OVERVIEW",
    answer:
      "ARX AI is a disciplined trading command center. It scans markets, scores opportunities, enforces risk rules, and lets you rehearse trades in demo or simulator mode before any real broker is ever connected.",
    detail:
      "ARX is built defense-first: live broker execution is OFF by default, the kill switch is ON, and the MT5 bridge is deferred until you intentionally connect it. Everything you do in the app — scanning, journaling, replaying, coaching — happens in demo or simulator mode unless you explicitly unlock real execution.",
    keywords: ["arx", "what is", "about", "overview", "app", "trading fortress"],
    chip: "What is ARX AI?",
  },
  {
    id: "tagline",
    title: "What does Analyze. Risk. eXecute. mean?",
    category: "OVERVIEW",
    answer:
      "Analyze = scan markets and score ideas. Risk = a governor that caps loss, drawdown, and exposure. eXecute = demo, simulator, or (only when you unlock it) bridged orders.",
    detail:
      "It's the order ARX enforces: you never reach eXecute without passing Analyze and Risk. The 'X' is intentionally capitalized — execution is the most guarded step in the app.",
    keywords: ["tagline", "analyze", "risk", "execute", "motto", "slogan"],
  },
  {
    id: "next-step",
    title: "What's the safest next step?",
    category: "OVERVIEW",
    answer:
      "Stay in demo / simulator mode. Run the readiness checklist, review a couple of replays, and journal a few simulated trades before even thinking about MT5.",
    detail:
      "There is no scenario where the assistant tells you to go live. The intended path is: Cockpit → Live Market → AI Trade Setup → demo-trade it → log it in Journal → review with Coach → only after weeks of clean demo results, consider configuring the MT5 bridge.",
    safety:
      "ARX never tells you to enable live trading. Safety locks stay on regardless of what the assistant says.",
    keywords: ["next step", "what next", "what should i do", "safest", "first thing"],
    chip: "What should I do next?",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2. STATUS BADGES (the chips at the top of the dashboard)
// ─────────────────────────────────────────────────────────────────────────────
const badges: KnowledgeEntry[] = [
  {
    id: "badge-mock",
    title: "MOCK badge",
    category: "BADGE",
    answer:
      "MOCK means market data and order execution are simulated locally. Nothing is hitting a broker. This is the default state.",
    keywords: ["mock", "mock badge", "mock mode", "simulated"],
  },
  {
    id: "badge-mt5",
    title: "MT5 badge",
    category: "BADGE",
    answer:
      "MT5 indicates whether the MetaTrader 5 bridge is connected. If it's grey or shows 'deferred', the bridge EA isn't sending heartbeats yet — live execution stays blocked.",
    related: [{ label: "MT5 Bridge", route: "/mt5-bridge" }, { label: "MT5 Status", route: "/mt5-status" }],
    keywords: ["mt5 badge", "mt5 chip", "metatrader badge"],
  },
  {
    id: "badge-running",
    title: "RUNNING badge",
    category: "BADGE",
    answer:
      "RUNNING means the demo bot loop is active and scanning the market every few seconds. It does NOT mean real orders are being placed.",
    keywords: ["running", "running badge", "bot running"],
  },
  {
    id: "badge-new-york",
    title: "NEW YORK / session badge",
    category: "BADGE",
    answer:
      "Shows the active trading session (London, New York, Tokyo, Sydney). Strategy weighting and liquidity expectations change per session.",
    related: [{ label: "Market Sessions", route: "/market-sessions" }],
    keywords: ["new york", "session", "session badge", "london", "tokyo"],
  },
  {
    id: "badge-full-tester",
    title: "FULL TESTER ACCESS",
    category: "BADGE",
    answer:
      "FULL TESTER ACCESS means every page is open for inspection, but real broker execution is still unavailable until the MT5 bridge is connected. It's a UI flag, not a permission to trade live.",
    safety:
      "Tester access never enables real orders. All execution paths remain demo / simulator.",
    keywords: ["full tester", "tester access", "tester", "tester mode"],
  },
  {
    id: "badge-sim-engine",
    title: "SIM ENGINE",
    category: "BADGE",
    answer:
      "SIM ENGINE = the synthetic price-and-order simulator that powers demo sessions, replay, and backtests. It's deterministic and runs in-process; no network calls leave the app.",
    related: [{ label: "Replay Simulator", route: "/replay-simulator" }, { label: "Demo Trading", route: "/demo-trading" }],
    keywords: ["sim engine", "simulator", "sim", "simulator engine"],
  },
  {
    id: "badge-fx-eurusd",
    title: "FX: EURUSD",
    category: "BADGE",
    answer:
      "Shows the currently selected symbol for the page's chart and signal context. Change it via the Symbol dropdown in the topbar.",
    keywords: ["fx eurusd", "symbol badge", "active symbol", "eurusd badge"],
  },
  {
    id: "badge-intents",
    title: "33 INTENTS (intent count)",
    category: "BADGE",
    answer:
      "Intents are queued trade ideas the AI has flagged for review — none of them are sent to a broker. They live in the Live Intent Queue and require manual confirmation, even in demo mode.",
    related: [{ label: "Live Intent Queue", route: "/live-intent-queue" }, { label: "Approval Queue", route: "/approval-queue" }],
    keywords: ["intents", "intent count", "33 intents", "queue", "intent badge"],
    chip: "What does the intents count mean?",
  },
  {
    id: "badge-explain-all",
    title: "Explain current status badges",
    category: "BADGE",
    answer:
      "The chips across the top of the dashboard show: trading mode (MOCK / MT5), bot state (RUNNING / PAUSED), active session (e.g. NEW YORK), tester access flag, simulator engine, current symbol, and queued intent count.",
    detail:
      "Tap any individual badge in this assistant (e.g. 'What is MOCK?', 'What is the intents count?') for a focused explanation.",
    keywords: ["explain badges", "what are these badges", "status badges", "all badges", "explain status"],
    chip: "Explain current status badges",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 3. SAFETY SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
const safety: KnowledgeEntry[] = [
  {
    id: "emergency-stop",
    title: "Emergency Stop / kill switch",
    category: "SAFETY",
    answer:
      "Emergency Stop is the big red lever that immediately halts all bot scanning, blocks new intents, and (when MT5 is connected) attempts to close open broker positions. It's ON by default.",
    detail:
      "The kill switch is enforced both client-side and server-side. Toggling it OFF requires multi-step confirmation. Even with the kill switch off, demo-mode locks still prevent live orders unless every other safety gate also passes.",
    safety: "If you're ever unsure, leave the kill switch ON. It cannot hurt anything to stay stopped.",
    related: [{ label: "Emergency", route: "/emergency" }],
    keywords: ["emergency stop", "kill switch", "stop trading", "freeze", "halt", "panic"],
    chip: "What does Emergency Stop do?",
  },
  {
    id: "demo-mode",
    title: "Demo mode",
    category: "SAFETY",
    answer:
      "Demo mode means every order is routed to your per-user MT5 demo account. No live broker is touched. ARX boots into demo and stays there until you intentionally unlock live execution.",
    related: [{ label: "Demo Trading", route: "/demo-trading" }, { label: "MT5 Setup", route: "/mt5-bridge" }],
    keywords: ["demo only", "demo mode", "demo trading", "simulated trading"],
    chip: "What does Demo mode mean?",
  },
  {
    id: "live-disabled",
    title: "Why is live trading disabled?",
    category: "SAFETY",
    answer:
      "Live trading is OFF by default and stays off until: (1) the MT5 bridge is connected and sending heartbeats, (2) the kill switch is OFF, (3) readiness checks pass, and (4) you complete the multi-step LIVE confirmation in Bot Control.",
    detail:
      "Any one of those gates failing keeps the app in demo mode. The most common reason live is off is simply: the MT5 bridge isn't connected — the EA hasn't sent a heartbeat yet.",
    safety:
      "ARX will not enable live trading for you. This is intentional. It is the user's deliberate, multi-step action.",
    related: [{ label: "Bot Control", route: "/bot-control" }, { label: "MT5 Status", route: "/mt5-status" }],
    keywords: ["live trading disabled", "why is live off", "live execution off", "real orders disabled", "broker execution off"],
    chip: "Why is live trading disabled?",
  },
  {
    id: "broker-readonly",
    title: "Broker read-only mode",
    category: "SAFETY",
    answer:
      "Read-only means ARX can read account balance, open positions, and history from MT5 but cannot place, modify, or close orders. It's a safe inspection mode.",
    related: [{ label: "Broker (read-only)", route: "/broker-readonly" }, { label: "Broker", route: "/broker" }],
    keywords: ["broker readonly", "read only", "broker read only", "readonly mode"],
  },
  {
    id: "autopilot-blocked",
    title: "Autopilot is blocked",
    category: "SAFETY",
    answer:
      "Autopilot needs every safety gate green: kill switch off, readiness pass, MT5 connected (or explicit demo-autopilot mode), and a confirmed risk profile. Until then, the autopilot stays in standby.",
    related: [{ label: "AI Autopilot", route: "/ai-autopilot" }, { label: "Autopilot Control Center", route: "/autopilot-control-center" }],
    keywords: ["autopilot blocked", "autopilot off", "autopilot disabled", "auto trading off"],
  },
  {
    id: "why-blocked",
    title: "Why am I blocked?",
    category: "SAFETY",
    answer:
      "Open the Readiness Checklist — it lists every gate, which ones are green, and which one is failing. The most common blockers are: MT5 bridge not connected, kill switch ON, missing risk profile, or no completed demo session.",
    detail:
      "If you're trying to start a demo session and it's blocked, the usual cause is missing risk parameters or no symbol selected. If you're trying to go live, it's almost always the MT5 bridge.",
    related: [
      { label: "Readiness Checklist", route: "/readiness-checklist" },
      { label: "Trading Readiness", route: "/trading-readiness" },
    ],
    keywords: ["blocked", "why blocked", "why am i blocked", "cannot start", "locked", "disabled", "unavailable"],
    chip: "Why am I blocked?",
  },
  {
    id: "demo-session-blockers",
    title: "Why can't I start a demo session?",
    category: "SAFETY",
    answer:
      "Demo sessions require: a selected symbol, a saved risk profile, VERIFIED_DEMO status, and the MT5 demo bridge armed from MT5 Setup. Open Readiness Checklist to see which one is missing.",
    related: [
      { label: "Readiness Checklist", route: "/readiness-checklist" },
      { label: "Demo Trading", route: "/demo-trading" },
      { label: "Risk Profile", route: "/risk-profile" },
    ],
    keywords: ["demo session blocked", "cannot start demo", "demo not starting", "start demo session", "paper session blocked"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 4. MT5 BRIDGE
// ─────────────────────────────────────────────────────────────────────────────
const mt5: KnowledgeEntry[] = [
  {
    id: "mt5-deferred",
    title: "Why is MT5 deferred?",
    category: "MT5",
    answer:
      "Deferred means the MT5 bridge is intentionally not connected yet. ARX runs entirely on the simulator until you (a) install the ARX EA in MT5, (b) configure the bridge token in env, and (c) confirm heartbeats are arriving.",
    related: [{ label: "MT5 Bridge", route: "/mt5-bridge" }, { label: "MT5 Setup", route: "/mt5-setup" }, { label: "MT5 Status", route: "/mt5-status" }],
    keywords: ["mt5 deferred", "metatrader deferred", "mt5 disconnected", "bridge deferred"],
    chip: "Why is MT5 deferred?",
  },
  {
    id: "mt5-bridge",
    title: "How does the MT5 bridge work?",
    category: "MT5",
    answer:
      "An Expert Advisor running inside MetaTrader 5 sends heartbeat + account snapshots to ARX, polls a command queue, executes the commands, and reports results back. ARX never connects directly to your broker — only the EA does.",
    detail:
      "Your MetaTrader 5 install talks to ARX over a small set of HTTPS routes (heartbeat, command poll, command result, account sync, position sync). Each connection is authenticated with a per-user bridge token you generate from the MT5 Setup page. If that token is missing or invalid, the bridge stays in a safe disconnected state.",
    safety: "ARX never asks for your broker password or login. The EA stays inside your MT5 terminal.",
    related: [{ label: "MT5 Setup", route: "/mt5-setup" }],
    keywords: ["mt5 bridge", "how mt5 works", "ea bridge", "expert advisor", "metatrader bridge"],
    chip: "How does the MT5 bridge work?",
  },
  {
    id: "heartbeat",
    title: "What is the MT5 heartbeat?",
    category: "MT5",
    answer:
      "The heartbeat is a small periodic check-in from the ARX bridge inside MetaTrader that proves MT5 is alive and connected. No heartbeat = bridge is considered down.",
    related: [{ label: "MT5 Status", route: "/mt5-status" }],
    keywords: ["heartbeat", "mt5 heartbeat", "ea heartbeat", "bridge heartbeat"],
  },
  {
    id: "no-heartbeat",
    title: "What happens when heartbeat is missing?",
    category: "MT5",
    answer:
      "Without recent heartbeats, the bridge is treated as disconnected. Live execution stays blocked, the MT5 badge goes grey, and live workflows refuse to arm. Open MT5 Status to see the last heartbeat timestamp.",
    related: [{ label: "MT5 Status", route: "/mt5-status" }, { label: "Admin Diagnostics", route: "/admin/diagnostics" }],
    keywords: ["no heartbeat", "missing heartbeat", "heartbeat down", "bridge disconnected"],
  },
  {
    id: "connect-mt5",
    title: "How do I connect MT5?",
    category: "MT5",
    answer:
      "1) Open ARX MT5 Setup and create your personal bridge token (shown once). 2) Install the ARX bridge from the MT5 Setup download into MetaTrader. 3) Paste your bridge token and ARX URL into the bridge inputs. 4) Allow WebRequest to the ARX domain in MT5. 5) Watch the MT5 Bridge page for an incoming heartbeat (usually within 10 seconds).",
    related: [{ label: "MT5 Setup", route: "/mt5-setup" }, { label: "MT5 Bridge", route: "/mt5-bridge" }],
    keywords: ["connect mt5", "setup mt5", "install ea", "mt5 setup", "configure mt5"],
    chip: "How do I connect MT5?",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 5. PAPER vs SIMULATOR vs LIVE
// ─────────────────────────────────────────────────────────────────────────────
const paperLive: KnowledgeEntry[] = [
  {
    id: "demo-vs-sim",
    title: "How is demo trading different from simulator mode?",
    category: "DEMO",
    answer:
      "Demo trading routes orders to your per-user MT5 demo account — real broker plumbing, fake money. Simulator mode is the in-process engine that generates synthetic prices for scans, replay, and backtests. Demo touches the bridge; simulator stays local.",
    related: [{ label: "Demo Trading", route: "/demo-trading" }, { label: "Replay Simulator", route: "/replay-simulator" }],
    keywords: ["demo vs simulator", "demo vs sim", "paper vs simulator", "paper vs sim", "difference paper sim", "paper or simulator"],
  },
  {
    id: "sim-vs-broker",
    title: "How is simulator mode different from broker-connected mode?",
    category: "DEMO",
    answer:
      "Simulator = synthetic data and synthetic fills, fully local. Broker-connected = real account data via the MT5 bridge. Even when MT5 is connected, ARX defaults to read-only and only places real orders after you unlock live execution.",
    keywords: ["simulator vs broker", "sim vs broker", "broker connected", "real broker"],
  },
  {
    id: "shadow-mode",
    title: "What is Shadow mode?",
    category: "DEMO",
    answer:
      "Shadow mode runs the strategy against live or recorded data and journals what it WOULD have done — without ever sending an order. It's the safest way to evaluate a strategy.",
    related: [{ label: "Shadow Mode", route: "/shadow-mode" }, { label: "Shadow Journal", route: "/shadow-journal" }],
    keywords: ["shadow mode", "shadow", "shadow trading", "shadow journal"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 6. RISK
// ─────────────────────────────────────────────────────────────────────────────
const risk: KnowledgeEntry[] = [
  {
    id: "risk-governor",
    title: "What does the Risk Governor do?",
    category: "RISK",
    answer:
      "The Risk Governor is the gatekeeper that enforces max daily loss, max drawdown, position size caps, exposure limits, and confidence thresholds. Any trade that violates a rule is rejected — paper or live.",
    related: [{ label: "Risk Governor", route: "/risk-governor" }, { label: "Risk Settings", route: "/risk-settings" }, { label: "Risk Manager", route: "/risk-command-center" }],
    keywords: ["risk governor", "risk rules", "risk engine", "loss cap", "drawdown cap"],
  },
  {
    id: "risk-page",
    title: "What does the Risk page do?",
    category: "RISK",
    answer:
      "It shows your current risk posture: open exposure, today's P&L vs limits, drawdown, correlated risk, and any rule violations. Tweak limits in Risk Settings; see deeper detail in Risk Command Center.",
    related: [
      { label: "Risk Settings", route: "/risk-settings" },
      { label: "Risk Command Center", route: "/risk-command-center" },
      { label: "Risk Events", route: "/risk-events" },
    ],
    keywords: ["risk page", "risk tab", "risk view", "risk dashboard"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 7. NAVIGATION (the 4 mobile tabs + sidebar groups)
// ─────────────────────────────────────────────────────────────────────────────
const navigation: KnowledgeEntry[] = [
  {
    id: "nav-cockpit",
    title: "Cockpit page",
    category: "NAV",
    answer:
      "Cockpit is the main dashboard. Account balance, P&L, win rate, drawdown, open trades, and the freshest signals — at a glance.",
    related: [{ label: "Open Cockpit", route: "/" }],
    keywords: ["cockpit", "dashboard", "home", "main page"],
  },
  {
    id: "nav-trade",
    title: "Trade page",
    category: "NAV",
    answer:
      "Trade is where you build, queue, and review trade ideas. Manual ticket, plan builder, and the live intent queue all live here.",
    related: [
      { label: "Manual Trade Ticket", route: "/manual-trade-ticket" },
      { label: "Trade Plan Builder", route: "/trade-plan-builder" },
      { label: "Live Intent Queue", route: "/live-intent-queue" },
    ],
    keywords: ["trade page", "trade tab", "trading page"],
  },
  {
    id: "nav-ai",
    title: "AI page",
    category: "NAV",
    answer:
      "AI is your reasoning hub: Coach for feedback, Mentor for explanations, Decisions for the audit trail of why a signal was generated, and Readiness for go/no-go scoring.",
    related: [
      { label: "AI Coach", route: "/ai-coach" },
      { label: "AI Mentor", route: "/ai-mentor" },
      { label: "AI Decisions", route: "/ai-decisions" },
      { label: "AI Readiness Score", route: "/ai-readiness-score" },
    ],
    keywords: ["ai page", "ai tab", "ai hub"],
  },
  {
    id: "nav-risk",
    title: "Risk page (mobile tab)",
    category: "NAV",
    answer:
      "Risk is your protection center: Risk Governor, Settings, Events, and the Emergency Stop. Always your first stop when something feels off.",
    related: [{ label: "Risk Settings", route: "/risk-settings" }, { label: "Emergency", route: "/emergency" }],
    keywords: ["risk tab", "risk mobile"],
  },
  {
    id: "nav-more",
    title: "More menu",
    category: "NAV",
    answer:
      "More groups everything that doesn't fit on the four primary tabs: settings, admin, audit log, brand kit, security, release notes, etc.",
    keywords: ["more", "more menu", "more tab"],
  },
  {
    id: "nav-help-center",
    title: "Help Center",
    category: "NAV",
    answer:
      "The Help Center is the full searchable library of help topics, playbooks, and troubleshooting articles. The floating assistant is the lightweight version of it.",
    related: [{ label: "Help Center", route: "/help" }],
    keywords: ["help center", "help page", "documentation", "docs"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 8. AI FEATURES (Coach, Replay, Readiness, etc.)
// ─────────────────────────────────────────────────────────────────────────────
const features: KnowledgeEntry[] = [
  {
    id: "ai-coach",
    title: "What does the AI Coach do?",
    category: "FEATURE",
    answer:
      "The Coach reviews your journal, recent trades, and discipline metrics and gives you specific behavioral feedback — not predictions. Think of it as a structured post-trade debrief.",
    related: [{ label: "AI Coach", route: "/ai-coach" }, { label: "Trader Coach", route: "/trader-coach" }, { label: "Post-Trade Debriefs", route: "/post-trade-debriefs" }],
    keywords: ["ai coach", "coach", "what does coach do", "trader coach"],
    chip: "What does the AI Coach do?",
  },
  {
    id: "replay",
    title: "What does Replay do?",
    category: "FEATURE",
    answer:
      "Replay re-runs historical or recorded market data through the strategy and order engine so you can rehearse a setup bar-by-bar. Nothing leaves the simulator.",
    related: [{ label: "Market Replay", route: "/market-replay" }, { label: "Replay Simulator", route: "/replay-simulator" }],
    keywords: ["replay", "market replay", "rehearse", "re-run"],
    chip: "What does Replay do?",
  },
  {
    id: "readiness",
    title: "What does Readiness check?",
    category: "FEATURE",
    answer:
      "Readiness scores every gate that must be green before a trading action: data feed, simulator state, risk profile, MT5 status, kill switch, journal completeness. It's the single place to see why something's blocked.",
    related: [
      { label: "Readiness", route: "/readiness" },
      { label: "Readiness Checklist", route: "/readiness-checklist" },
      { label: "Trading Readiness", route: "/trading-readiness" },
      { label: "AI Readiness Score", route: "/ai-readiness-score" },
    ],
    keywords: ["readiness", "readiness check", "what does readiness do", "ready to trade"],
  },
  {
    id: "data",
    title: "What does the Data page do?",
    category: "FEATURE",
    answer:
      "Data covers imports (CSV candles), data quality checks, and data protection settings. It's the source-of-truth for what the strategies see.",
    related: [
      { label: "Data Import", route: "/data-import" },
      { label: "Data Quality", route: "/data-quality" },
      { label: "Data Protection", route: "/data-protection" },
    ],
    keywords: ["data", "data page", "data import", "data quality"],
  },
  {
    id: "feedback",
    title: "How does feedback / reporting work?",
    category: "FEATURE",
    answer:
      "Use 'Report an issue' in this assistant or the Feedback Center. Reports are stored locally with the route, viewport, and your description. Tokens, secrets, and broker credentials are never collected.",
    related: [{ label: "Feedback Center", route: "/feedback-center" }, { label: "Admin Issues", route: "/admin/issues" }],
    keywords: ["feedback", "report issue", "bug report", "support"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 9. PERMISSIONS / ROLES
// ─────────────────────────────────────────────────────────────────────────────
const permissions: KnowledgeEntry[] = [
  {
    id: "permissions",
    title: "What do the permission levels mean?",
    category: "PERMISSION",
    answer:
      "Roles are USER (read most pages), TESTER (full UI access for testing, no live execution), ADMIN (data + diagnostics), OWNER (everything including future live unlocks). Roles come from the server session — never trust client-set headers.",
    related: [{ label: "Roles & Permissions", route: "/roles-permissions" }, { label: "Admin Permissions", route: "/admin/permissions" }],
    keywords: ["permissions", "roles", "permission levels", "user role", "admin", "owner", "tester"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 10. TROUBLESHOOTING
// ─────────────────────────────────────────────────────────────────────────────
const troubleshooting: KnowledgeEntry[] = [
  {
    id: "trouble-no-signals",
    title: "No signals are showing",
    category: "TROUBLE",
    answer:
      "Check: (1) bot state is RUNNING (top badges), (2) a symbol is selected, (3) at least one strategy is enabled in Strategy Settings, (4) the No-Trade filter isn't blocking the current session.",
    related: [{ label: "Strategy Settings", route: "/strategy-settings" }, { label: "Bot Control", route: "/bot-control" }],
    keywords: ["no signals", "no trades", "scanner empty", "nothing happening"],
  },
  {
    id: "trouble-mt5-not-connecting",
    title: "MT5 won't connect",
    category: "TROUBLE",
    answer:
      "1) Confirm your personal bridge token is configured in MT5. 2) In MT5 → Tools → Options → Expert Advisors, allow WebRequest for the ARX URL. 3) Open the MT5 Experts tab and look for the ARX bridge status lines. 4) From ARX MT5 Setup, run the connection test. 5) Watch the MT5 Bridge page — the heartbeat should arrive within 10 seconds.",
    related: [{ label: "MT5 Status", route: "/mt5-status" }, { label: "MT5 Bridge", route: "/mt5-bridge" }],
    keywords: ["mt5 not connecting", "bridge not working", "no heartbeat", "ea not sending"],
  },
  {
    id: "trouble-app-stuck",
    title: "Something feels stuck or laggy",
    category: "TROUBLE",
    answer:
      "Hard-refresh (Ctrl/Cmd+Shift+R), then check the System Health page for error counts. If a specific page is broken, use 'Report an issue' in this assistant — the route is captured automatically.",
    related: [{ label: "System Health", route: "/system-health" }, { label: "Admin Diagnostics", route: "/admin/diagnostics" }],
    keywords: ["stuck", "laggy", "slow", "frozen", "broken"],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────
export const ARX_KNOWLEDGE: KnowledgeEntry[] = [
  ...overview,
  ...badges,
  ...safety,
  ...mt5,
  ...paperLive,
  ...risk,
  ...navigation,
  ...features,
  ...permissions,
  ...troubleshooting,
];

/** Aliases / synonyms used by the search layer. */
export const ALIASES: Record<string, string[]> = {
  "demo session": ["demo mode", "demo trading", "paper session", "paper mode", "paper trading", "test trade", "simulated session"],
  mt5: ["metatrader", "bridge", "ea", "expert advisor", "heartbeat"],
  "live trading": ["broker execution", "real orders", "live broker", "live execution"],
  blocked: ["disabled", "locked", "unavailable", "cannot start", "not ready", "off"],
  "emergency stop": ["kill switch", "stop trading", "freeze execution", "safety lock", "panic button"],
  cockpit: ["dashboard", "home"],
  coach: ["mentor", "feedback", "review"],
  replay: ["rehearse", "playback", "historical run"],
  readiness: ["ready", "checklist", "go no go"],
  intent: ["intents", "queue", "queued idea"],
};

/** Resolve aliases in a query string into canonical tokens. */
export function expandAliases(query: string): string {
  let q = ` ${query.toLowerCase()} `;
  for (const [canonical, words] of Object.entries(ALIASES)) {
    for (const w of words) {
      const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      q = q.replace(re, canonical);
    }
  }
  return q.trim();
}
