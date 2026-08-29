/**
 * Route → page-knowledge registry.
 *
 * Every route declared in App.tsx has an entry (exact match), or is covered
 * by a prefix group (e.g. /admin/*, /orders/*, /positions/*). The
 * `validateRouteCoverage()` helper at the bottom asserts coverage.
 *
 * Keep entries SHORT. Detailed answers live in `arxAppKnowledge.ts`.
 */

export interface RouteKnowledge {
  /** Path or path prefix (ending with `/*` for prefix match). */
  route: string;
  title: string;
  purpose: string;
  controls?: string[];
  safety?: string;
  questions?: string[];
  related?: string[];
}

/* eslint-disable max-len */
export const ROUTE_KNOWLEDGE: RouteKnowledge[] = [
  // ── Main / Cockpit ──────────────────────────────────────────────────────
  { route: "/", title: "Cockpit", purpose: "Main dashboard: balance, P&L, win rate, drawdown, open trades, fresh signals.", controls: ["Symbol selector", "Status badges", "Quick actions"], questions: ["What is ARX AI?", "What do these badges mean?"], related: ["/portfolio", "/help"] },
  // /dashboard removed — never declared in App.tsx (the dashboard lives at "/"),
  // so registering it sent walkthroughs and related-chips to a 404.
  // /trading-cockpit and /trading-command-center removed (Phase 3 — both backed
  // by the paper-only TradingCockpit page).
  { route: "/trade-command-room", title: "Trade Command Room", purpose: "Focused execution room: ticket + queue + risk readout.", related: ["/manual-trade-ticket"] },
  { route: "/brain", title: "ARX Brain", purpose: "Deep-dive into the AI's reasoning state.", related: ["/ai-decisions"] },

  // ── Markets / Charts / Scanner ─────────────────────────────────────────
  // /live-market removed — never declared in App.tsx. The realtime market view
  // is /live-chart (single symbol) and /market-scanner (ranked signals).
  { route: "/live-chart", title: "Live Chart", purpose: "Single-symbol live chart with overlays.", related: ["/charts"] },
  { route: "/charts", title: "Charts", purpose: "Multi-chart workspace with annotation tools.", related: ["/live-chart"] },
  { route: "/market-scanner", title: "Market Scanner", purpose: "Scans configured symbols and ranks signals by confidence.", controls: ["Strategy filter", "Min confidence"], related: ["/scanner", "/strategy-settings"] },
  { route: "/scanner", title: "Scanner", purpose: "Lighter scanner view with the same signal source.", related: ["/market-scanner"] },
  { route: "/market-health", title: "Market Health", purpose: "Volatility, spread, and session quality indicators.", related: ["/market-sessions"] },
  { route: "/market-sessions", title: "Market Sessions", purpose: "Schedule of London/NY/Tokyo/Sydney sessions and overlap windows." },
  { route: "/economic-calendar", title: "Economic Calendar", purpose: "Upcoming releases that move FX and indices.", related: ["/news-risk"] },
  { route: "/calendar", title: "Calendar (moved)", purpose: "Redirects to the Economic Calendar, the one calendar surface.", related: ["/economic-calendar"] },
  { route: "/trading-calendar", title: "Trading Calendar", purpose: "Calendar focused on planned trading windows.", related: ["/economic-calendar"] },
  { route: "/news-risk", title: "News Risk (moved)", purpose: "Redirects to the Economic Calendar's News Risk tab — same real calendar-backed verdicts.", related: ["/economic-calendar"] },

  // ── AI ─────────────────────────────────────────────────────────────────
  { route: "/ai-trading", title: "AI Trade Setup", purpose: "AI-assisted entry / exit / risk suggestions for the current symbol.", safety: "Suggestions only — orders never auto-send.", related: ["/ai-decisions", "/ai-readiness-score"] },
  { route: "/ai-coach", title: "AI Coach", purpose: "Behavioral feedback on your discipline and journal.", questions: ["What does the AI Coach do?"], related: ["/trader-coach", "/post-trade-debriefs"] },
  { route: "/ai-mentor", title: "AI Mentor", purpose: "Explains setups and concepts in plain language.", related: ["/ai-coach"] },
  { route: "/ai-decisions", title: "AI Decisions", purpose: "Audit trail of every AI decision: inputs, score, gates, outcome.", related: ["/ai-trading"] },
  { route: "/ai-command-center", title: "AI Command Center", purpose: "Top-level AI status: models, prompts, intents, calibration.", related: ["/ai-decisions", "/confidence-calibration"] },
  { route: "/ai-readiness-score", title: "AI Readiness Score", purpose: "AI's confidence that the current setup is trade-worthy.", related: ["/readiness"] },
  { route: "/ai-autopilot", title: "AI Autopilot", purpose: "Hands-free auto-execution path. Disabled until every safety gate is green.", safety: "Autopilot stays demo-only unless live execution is explicitly unlocked.", related: ["/autopilot-control-center", "/readiness"] },
  { route: "/autopilot-control-center", title: "Autopilot Control Center", purpose: "Detailed autopilot configuration, kill switches, and audit." },
  { route: "/live-ai-assist", title: "Live AI Assist", purpose: "Real-time AI co-pilot during a session." },
  { route: "/live-ai-auto-test", title: "Live AI Auto-Test", purpose: "Smoke-tests the live AI assist pipeline end-to-end." },
  { route: "/confidence-calibration", title: "Confidence Calibration", purpose: "Tracks predicted vs realized win rate per confidence bucket." },
  { route: "/edge-discovery", title: "Edge Discovery", purpose: "Surfaces patterns / setups that may have an edge based on history." },

  // ── Trade entry / queue ────────────────────────────────────────────────
  { route: "/manual-trade-ticket", title: "Manual Trade Ticket", purpose: "Manually build a trade with size, SL, TP, and journal note.", related: ["/trade-plan-builder"] },
  { route: "/trade-plan-builder", title: "Trade Plan Builder", purpose: "Structured plan: thesis, invalidation, target, risk." },
  { route: "/live-intent-queue", title: "Live Intent Queue", purpose: "Queued AI/manual trade intents awaiting confirmation.", safety: "Intents never auto-fire. Manual confirmation required, even in demo.", related: ["/approval-queue"] },
  { route: "/approval-queue", title: "Approval Queue", purpose: "Multi-step approval gate for sensitive actions.", related: ["/live-intent-queue"] },
  { route: "/playbook", title: "Playbook", purpose: "Your saved setups and the rules for each.", related: ["/trade-plan-builder"] },

  // ── Positions / Orders / History ───────────────────────────────────────
  // /open-trades and /trade-history removed — never declared in App.tsx. Both
  // live on /my-trades (open positions + full history in one blotter).
  { route: "/my-trades", title: "My Trades", purpose: "All your trades in one blotter: currently open positions plus full historical trades with filters.", related: ["/positions", "/orders", "/journal"] },
  { route: "/my-trades/*", title: "Trade Detail", purpose: "Detail view of a single trade: fills, P&L, risk, and journal notes.", related: ["/my-trades"] },
  { route: "/positions", title: "Positions", purpose: "Position blotter with size, P&L, and exposure." },
  { route: "/positions/*", title: "Positions", purpose: "Demo/Live filtered position views." },
  { route: "/orders", title: "Orders", purpose: "Order blotter: pending, filled, rejected." },
  { route: "/orders/*", title: "Orders", purpose: "Demo/Live filtered order views." },
  { route: "/live-trades", title: "Live Trades", purpose: "Read-only view of trades on the connected MT5 account.", safety: "Read-only. Cannot modify or close from here." },
  { route: "/trade-logs", title: "Trade Logs", purpose: "Raw trade-level logs with strategy attribution." },
  { route: "/trade-grader", title: "Trade Grader", purpose: "Grades each trade A–F against rules and behavior." },

  // ── Bot / Live execution ───────────────────────────────────────────────
  { route: "/bot-control", title: "Bot Control", purpose: "Start, pause, stop the bot. Toggle Demo / LIVE mode.", safety: "LIVE requires multi-step confirmation and is gated by every safety check.", related: ["/emergency", "/readiness"] },
  { route: "/live-trading", title: "Live Trading", purpose: "Live execution overview. Disabled until the MT5 bridge + safety gates pass.", safety: "LIVE TRADING DISABLED is server-enforced and cannot be flipped from the UI or assistant. The page is informational only.", controls: ["status panel", "readiness summary", "go-to-readiness link"], related: ["/readiness-checklist", "/mt5-bridge", "/risk-governor"] },
  { route: "/live-trading-control", title: "Live Trading Control", purpose: "Granular live-execution controls and gates." },
  { route: "/live-manual", title: "Live Manual", purpose: "Manual live order entry surface (gated)." },
  { route: "/demo-trading", title: "Demo Trading", purpose: "Demo execution surface — never sends real orders." },

  // ── Simulator ──────────────────────────────────────────────────────────
  // Paper Trading routes (/paper-trading, /paper-testing-launch,
  // /active-paper-session) removed in Phase 3 — feature retired.
  { route: "/replay-simulator", title: "Replay Simulator", purpose: "Replay historical bars through the strategy + order engine." },
  { route: "/market-replay", title: "Market Replay", purpose: "Bar-by-bar replay of recorded sessions." },
  { route: "/shadow-mode", title: "Shadow Mode (moved)", purpose: "Admin: redirects to the Testing Lab's Shadow Mode tab — the strategy journals what it WOULD do, no orders sent.", related: ["/testing-lab", "/shadow-journal"] },
  { route: "/shadow-journal", title: "Shadow Journal", purpose: "Journal of shadow-mode hypothetical trades." },
  // /backtest is a redirect to Testing Lab, kept only so existing links and
  // bookmarks resolve. Its old description ("Upload candle CSV, run a
  // backtest") advertised a page that no longer exists — and that page was
  // itself the fabrication being removed: it read the uploaded CSV into state,
  // ignored it, and submitted Math.random() candles instead. Describing it
  // accurately keeps the assistant from sending anyone to upload a CSV.
  { route: "/backtest", title: "Backtest (moved)", purpose: "Redirects to Testing Lab, which owns backtesting.", related: ["/testing-lab"] },
  { route: "/testing-lab", title: "Testing Lab", purpose: "Unified workspace to backtest, forward-test, compare historical vs live results, and review strategy history.", related: ["/shadow-mode"] },

  // ── Strategy ───────────────────────────────────────────────────────────
  { route: "/strategy-settings", title: "Strategy Settings", purpose: "Toggle the 5 modular strategies and their parameters." },
  { route: "/strategy-lab", title: "Strategy Lab", purpose: "Experiment with strategy variants in isolation." },
  { route: "/strategy-promotion", title: "Strategy Promotion (moved)", purpose: "Admin: redirects to the Testing Lab's Promotion tab — a research ledger of strategy levels that never drives live execution.", related: ["/testing-lab"] },
  { route: "/strategy-tournament", title: "Strategy Tournament (moved)", purpose: "Admin: redirects to the Testing Lab's Tournament tab — shadow-stat comparison of strategies.", related: ["/testing-lab"] },
  { route: "/rule-contracts", title: "Rule Contracts", purpose: "Formal contracts the bot must satisfy (entry/exit/risk)." },

  // ── Risk ───────────────────────────────────────────────────────────────
  { route: "/risk-governor", title: "Risk Governor", purpose: "The gatekeeper enforcing all risk rules — daily loss caps, drawdown ceiling, per-trade exposure, and correlated-risk checks.", safety: "Server-enforced. The assistant cannot relax, bypass, or temporarily disable any governor rule.", controls: ["loss cap", "drawdown ceiling", "exposure cap", "rule status list"], related: ["/risk-command-center", "/readiness-checklist", "/safety-logs"] },
  { route: "/risk-settings", title: "Risk Settings", purpose: "Max loss, lot size, drawdown, confidence threshold, etc." },
  { route: "/risk-command-center", title: "Risk Command Center", purpose: "Aggregate risk view: exposure, drawdown, correlated risk, kill-switch access.", safety: "Read mostly; destructive controls are server-gated. Assistant cannot bypass any cap.", controls: ["exposure chart", "drawdown chart", "kill switch link"], related: ["/risk-governor", "/emergency", "/safety-logs"] },
  { route: "/risk-events", title: "Risk Events", purpose: "Stream of every risk-rule trigger with context." },
  { route: "/risk-profile", title: "Risk Profile", purpose: "Saved profile (conservative/balanced/aggressive) applied to the bot." },
  { route: "/emergency", title: "Emergency", purpose: "Big red kill-switch panel. Stops everything immediately.", safety: "Always safe to engage. Cannot harm anything to stop." },

  // ── Performance / Journal ──────────────────────────────────────────────
  { route: "/journal", title: "Journal", purpose: "Trading journal with notes, screenshots, tags." },
  { route: "/post-trade-debriefs", title: "Post-Trade Debriefs", purpose: "Structured AI-assisted debrief after each trade." },
  { route: "/performance-scorecard", title: "Performance Scorecard", purpose: "KPIs: win rate, expectancy, Sharpe-like ratios, discipline score." },
  { route: "/analytics", title: "Analytics", purpose: "Charts of daily P&L, equity curve, strategy breakdown." },
  { route: "/analytics-command", title: "Analytics Command", purpose: "Power view of analytics with cohort filters." },
  { route: "/weekly-review", title: "Weekly Review", purpose: "Weekly retro with discipline + P&L breakdown." },
  { route: "/session-report", title: "Session Report", purpose: "Per-session summary report." },
  { route: "/session-plan", title: "Session Plan", purpose: "Pre-market plan for the upcoming session." },
  { route: "/portfolio", title: "Portfolio", purpose: "Aggregate positions, P&L, and allocations." },

  // ── MT5 / Broker ───────────────────────────────────────────────────────
  { route: "/mt5-bridge", title: "MT5 Bridge", purpose: "MT5 bridge configuration, EA download, and connectivity status.", safety: "Bridge is off by default. Even when the EA is connected, LIVE TRADING DISABLED + BROKER READ-ONLY locks remain in force until each is individually cleared server-side.", controls: ["bridge status", "EA download", "heartbeat indicator", "token field"], related: ["/readiness-checklist", "/risk-governor", "/safety-logs"], questions: ["How do I connect MT5?", "Why is MT5 deferred?"] },
  { route: "/mt5-setup", title: "MT5 Setup", purpose: "Step-by-step EA install and WebRequest allow-listing." },
  { route: "/mt5-status", title: "MT5 Status", purpose: "Live heartbeat, last sync, and bridge diagnostics.", related: ["/mt5-bridge"] },
  { route: "/broker", title: "Broker", purpose: "Broker connection summary and account info." },
  { route: "/broker-readonly", title: "Broker (read-only)", purpose: "Read-only broker view: balance, positions, history. Cannot send orders." },
  { route: "/broker-reconciliation", title: "Broker Reconciliation", purpose: "Reconciles ARX's view of trades with the broker's." },

  // ── Centers (markets/forex/indices/etc.) ───────────────────────────────
  // P0-4 — these four centers have NO market-data provider wired. They render
  // an honest not-connected state (no levels, no bias, no confidence, no ATR).
  // Ruby reads these descriptions, so they must say so plainly: previously the
  // pages served Math.random()-derived numbers and Ruby described the pages as
  // live workspaces, which made the assistant the last surface still implying
  // fabricated data was real. Point users at the Scanner, which uses real
  // broker data.
  { route: "/forex-center", title: "FX Center", purpose: "FX workspace. NO live FX macro provider is connected: currency strength, pair bias and confidence are NOT shown here. Use the Scanner for real FX prices and signals.", safety: "Shows an honest not-connected state. ARX never displays fabricated market data, so no estimated values appear on this page.", related: ["/scanner", "/market-scanner"] },
  { route: "/indices-center", title: "Indices Center", purpose: "Indices workspace. NO live index market-data provider is connected: index levels, VIX, bond yields, bias and confidence are NOT shown here.", safety: "Shows an honest not-connected state. ARX never displays fabricated market data, so no estimated values appear on this page.", related: ["/scanner"] },
  { route: "/stocks-center", title: "Stocks Center", purpose: "Stocks workspace. NO stock-data provider is connected: prices, directions and signals are NOT shown here.", safety: "Shows an honest not-connected state. ARX never displays fabricated signals.", related: ["/scanner"] },
  { route: "/synthetic-center", title: "Synthetics Center", purpose: "Deriv synthetics workspace. NO synthetic analytics provider is connected: ATR, trend, volatility state and recommended lot size are NOT shown here. Synthetics remain tradable on the Scanner, which uses real broker data.", safety: "Shows an honest not-connected state. ARX never displays fabricated market data or a position size derived from one.", related: ["/scanner"] },

  // ── Watch / Alerts / Notifications ─────────────────────────────────────
  { route: "/watchlists", title: "Watchlists", purpose: "Create and manage symbol watchlists." },
  { route: "/alerts", title: "Alerts", purpose: "Price/condition alerts." },
  { route: "/alerts-center", title: "Alerts Center", purpose: "All alerts across the app, with history." },
  { route: "/alert-preferences", title: "Alert Preferences", purpose: "Notification channels and thresholds." },
  { route: "/notifications", title: "Notifications", purpose: "In-app notification feed." },

  // ── Admin / Security / System ──────────────────────────────────────────
  { route: "/admin-control", title: "Admin Control", purpose: "Top-level admin landing." },
  { route: "/admin/cockpit", title: "Admin Cockpit", purpose: "Admin/owner-only control room unifying traders, investors, bridge/MT5, open trades & exposure, risk alerts, capital/pool/NAV, approval/activation, the admin-only Pattern Sync comparator, and the audit timeline.", controls: ["Approve / full-activation / suspend / restore / emergency-close a trader (reason-gated)", "Freeze / unfreeze an investor (reason-gated)", "Add an operator note", "Refresh all panels"], safety: "READ + operator control only. Every mutation routes through the existing audited admin handlers plus a cockpit audit row — no new execution path, relaxes no gate. Broker account values are masked unless the session is OWNER.", questions: ["Who is approved for live?", "What is the master bridge doing?", "What is our total open exposure?", "What are the active risk alerts?", "What is the pool NAV?"], related: ["/admin", "/admin/users", "/admin/live-shared", "/admin/audit-center"] },
  { route: "/admin/data-management", title: "Data Management", purpose: "Manage stored data, exports, retention." },
  { route: "/admin/diagnostics", title: "Diagnostics", purpose: "Server diagnostics: bridge probe, queue depth, error counts." },
  { route: "/assistant-knowledge-gaps", title: "Assistant Knowledge Gaps", purpose: "Tester/admin view of questions the ARX Assistant could not answer, so missing topics can be added to the knowledge base.", related: ["/feedback-center", "/help"], questions: ["What is a knowledge gap?", "How do I resolve a gap?"] },
  { route: "/assistant-knowledge-console", title: "Assistant Knowledge Console", purpose: "Tester/admin coverage console for the ARX Assistant — surfaces route, badge, and UI element coverage plus invariant checks and recent gaps.", safety: "Read-only diagnostics. Never enables live trading or bypasses any safety lock.", related: ["/assistant-knowledge-gaps", "/assistant-manual", "/feedback-center", "/help"], questions: ["What does this console show?", "How do I read coverage?"] },
  { route: "/assistant-manual", title: "Assistant App Manual", purpose: "Tester/admin internal manual generated from the compiled ARX knowledge index — every route, element, badge, safety lock, walkthrough, and glossary term in one place.", safety: "Read-only diagnostics. Normal users see only safe user-facing help content.", related: ["/assistant-knowledge-console", "/help"], questions: ["What is ARX AI?", "What are the assistant's limits?"] },
  { route: "/admin/issues", title: "Admin Issues", purpose: "Triage user-submitted issues." },
  { route: "/admin/live-shared", title: "Admin · Live Shared Account", purpose: "Operator-only switch-based cockpit for the shared live-account system: pinned master bridge, EA heartbeat, approved users, risk caps, open trades, kill switch, audit history. Includes the OWNER-only First Live Test Mode that pre-locks safest limits.", controls: ["Pin current master bridge (heartbeat-gated)", "Toggle activation switches (routing, master bridge LIVE, shared live, platform LIVE, release kill)", "Engage emergency kill switch", "First Live Test Mode switch (OWNER only)"], safety: "Every switch opens a confirmation dialog and writes an admin_action_audit_log row. No typed phrases. No broker credentials are ever stored or returned. ARX_LIVE_BROKER_EXECUTION_ENABLED env still gates broker dispatch.", questions: ["Are we ready to go live?", "Which users are approved?", "Is the bridge pinned?", "Is the kill switch released?", "What does First Live Test Mode do?"], related: ["/admin/live-shared/activation", "/admin/audit-center"] },
  { route: "/admin/live-shared/activation", title: "Admin · Live Shared Activation Cockpit", purpose: "Full operator cockpit to take the shared live-account system hot: switch-based wizard, smoke test, micro live test, emergency rollback, command queue monitor with stale-command protection.", controls: ["Switch-based activation wizard (each step confirms in a modal and writes an audit row)", "Smoke test (read-only)", "Micro live test (operator-as-self through validate→execute, confirmation modal)", "Cancel stale commands (confirmation modal)", "Emergency rollback (confirmation modal)"], safety: "Cannot skip steps. Cannot bypass any of the 16 Phase B gates, kill switch, ARX_LIVE_BROKER_EXECUTION_ENABLED hard-kill, per-user limits, idempotency, attribution, or audit logs. Rollback preserves audit logs, trade history, demo/paper, and EA-picked commands. EA-pull architecture preserved — no broker credentials on the server. No typed phrases anywhere — switches + confirm modals only.", questions: ["Are we ready to go live?", "What is blocking live activation?", "Is the bridge pinned?", "Is the EA fresh?", "Is the kill switch released or engaged?", "Which users are approved?", "Why was my trade blocked?", "What should I check before a micro live test?", "How do I roll back live trading?"], related: ["/admin/live-shared", "/admin/audit-center", "/live-shared"] },
  { route: "/admin/permissions", title: "Admin Permissions", purpose: "Manage roles and gates. Owner-only." },
  { route: "/admin/security-status", title: "Security Status", purpose: "Security posture summary." },
  { route: "/admin/system-health", title: "System Health", purpose: "Service health, uptime, error rates." },
  { route: "/system-health", title: "System Health", purpose: "Public system health view." },
  { route: "/status-command-center", title: "ARX Status Command Center", purpose: "Aggregated readiness, blockers, fix-first, setup checklist, and guided wizard.", controls: ["Readiness score", "Setup checklist", "Blocker cards", "Safe Setup wizard"], safety: "Read-only. Does not enable live trading or change broker/MT5/risk state.", questions: ["What should I fix first?", "Explain my readiness score", "Start safe setup", "Explain active blockers"], related: ["/help", "/readiness-checklist", "/mt5-bridge", "/emergency"] },
  { route: "/arx-status", title: "ARX Status", purpose: "Alias of the ARX Status Command Center.", related: ["/status-command-center"] },
  { route: "/audit-log", title: "Audit Log", purpose: "Append-only log of safety/admin events." },
  { route: "/audit-vault", title: "Audit Vault", purpose: "Long-term audit storage with retention." },
  { route: "/security-center", title: "Security Center", purpose: "User-visible security settings and posture." },
  { route: "/security-events", title: "Security Events", purpose: "Stream of security-relevant events." },
  { route: "/safety-logs", title: "Safety Logs", purpose: "Trace of every safety-gate decision." },
  { route: "/data-import", title: "Data Import", purpose: "Upload CSV / JSON market data and journal data." },
  { route: "/data-protection", title: "Data Protection", purpose: "Privacy & data-handling controls." },
  { route: "/data-quality", title: "Data Quality", purpose: "Detects gaps, spikes, and anomalies in data feeds." },
  { route: "/testing-control-center", title: "Testing Control Center", purpose: "Hub for demo/shadow/QA tests." },
  { route: "/release-notes", title: "Release Notes", purpose: "Per-release change log." },
  { route: "/release-status", title: "Release Status", purpose: "Status of the current release: gates, sign-offs." },
  { route: "/trading-readiness", title: "Trading Readiness", purpose: "Are you/the bot ready to trade right now?" },
  { route: "/readiness", title: "Readiness", purpose: "All-up readiness dashboard.", related: ["/readiness-checklist"] },
  { route: "/readiness-checklist", title: "Readiness Checklist", purpose: "Granular checklist showing each gate that must be green before live operation can be considered.", safety: "Read-only diagnostic. Items cannot be force-completed by the assistant or the UI; each gate must be satisfied by real app state.", controls: ["per-gate status", "evidence link", "next-step pointer"], related: ["/mt5-bridge", "/risk-governor", "/safety-logs"] },
  { route: "/roles-permissions", title: "Roles & Permissions", purpose: "Visible role / permission matrix." },

  // ── Onboarding / Help / Settings / Misc ────────────────────────────────
  { route: "/onboarding", title: "Onboarding", purpose: "First-run welcome and setup tour." },
  { route: "/help", title: "Help Center", purpose: "Searchable knowledge base of every help topic." },
  { route: "/settings", title: "Settings", purpose: "App preferences and account settings." },
  { route: "/feedback-center", title: "Feedback Center", purpose: "All your submitted feedback and replies." },
  { route: "/brand-kit", title: "Brand Kit", purpose: "ARX brand assets and color tokens." },
  { route: "/learning", title: "Learning", purpose: "Guides and lessons inside ARX." },
  { route: "/trader-coach", title: "Trader Coach", purpose: "Coach focused on trader behavior and psychology." },
  { route: "/trader-skill", title: "Trader Skill", purpose: "Skill tracker across strategies and conditions." },
  { route: "/prop-challenge", title: "Prop Challenge", purpose: "Track a prop-firm challenge inside ARX." },
  { route: "/prop-firm-mode", title: "Prop Firm Mode", purpose: "Apply prop-firm risk constraints to the bot." },
];
/* eslint-enable max-len */

/** Resolve a path to its knowledge entry. Exact match first, then prefix. */
export function resolveRoute(path: string): RouteKnowledge | null {
  const exact = ROUTE_KNOWLEDGE.find((r) => r.route === path);
  if (exact) return exact;
  for (const r of ROUTE_KNOWLEDGE) {
    if (r.route.endsWith("/*")) {
      const prefix = r.route.slice(0, -2);
      if (path === prefix || path.startsWith(prefix + "/")) return r;
    }
  }
  return null;
}

/** Validate that every declared route in App.tsx has knowledge coverage. */
export function validateRouteCoverage(declaredRoutes: string[]): {
  total: number;
  covered: number;
  missing: string[];
} {
  const missing = declaredRoutes.filter((p) => !resolveRoute(p));
  return { total: declaredRoutes.length, covered: declaredRoutes.length - missing.length, missing };
}
