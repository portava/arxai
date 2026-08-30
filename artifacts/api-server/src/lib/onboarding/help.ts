// Smart Help content + topic resolver.
//
// RANK 4 (critical) — this catalogue told every user the product was something
// it is not.
//
// WHAT IT USED TO SAY
//   const SAFETY_DEFAULT = "This app is PAPER_ONLY. Live trading is disabled
//   and cannot be enabled here." — stamped on 24 of 26 topics. Plus:
//     * "The broker connector here only reads account/position information. It
//       cannot place, modify, or close orders."
//     * "This build runs in PAPER_ONLY mode. The internal safety core does not
//       allow live order placement under any circumstance."
//     * "Live trading remains disabled." / "Acknowledgements ... never grant
//       live-trading permission."
//
// WHY THAT IS THE WORST KIND OF DEFECT HERE
//   Real orders dispatch on this build. lib/live/liveCommandPipeline.ts and
//   lib/phase6/guidedDispatchEntry.ts call a venue adapter's deliver(); the
//   Phase B evaluator in lib/domain/src/safety-contracts/livePhaseBDispatchGate.ts
//   exists precisely because live placement is possible and must be gated. A
//   user who asks the product's own help system whether they can trade live was
//   told, authoritatively, that it was impossible — so every safety explanation
//   described a system that no longer exists and they could not reason about
//   the gates that actually protect their capital.
//
// WHAT IT SAYS NOW
//   The real chain, in the user's language: live dispatch is DEFAULT-DENY
//   behind an operator master switch, an admin per-user live approval, a
//   per-user arming record, a signed risk disclosure, a per-user kill switch,
//   and 23 per-command gates that must ALL pass. Conservative, and true.
//
// RANK 51 — `page_route` also pointed at pages that do not exist
//   (/trading-cockpit, /paper-testing-launch, /active-paper-session declare no
//   <Route> anywhere in App.tsx) or that no human-trader allowlist contains
//   (/risk-settings, /broker-readonly, /readiness-checklist, /replay-simulator,
//   /data-import, /system-health are admin surfaces). 100% of the Help Center's
//   "Open page" links were therefore un-followable: a trader clicking one was
//   silently bounced to the cockpit or landed on Not Found. Every route below
//   is now a real <Route> AND on a human-trader allowlist; the Help Center
//   additionally re-checks each one against the viewer's own tier before
//   rendering the link (help-center.tsx), so a pending trader is never offered
//   an approved-only destination.

export interface HelpTopic {
  help_key: string;
  title: string;
  category: "COCKPIT" | "PAPER_SESSION" | "RISK" | "READINESS" | "COACH" | "REPLAY" | "DATA" | "BROKER" | "SAFETY" | "GENERAL";
  /** Must be a real route AND on a human-trader allowlist. null = no page. */
  page_route: string | null;
  content: string;
  safety_note: string;
  related_build: string;
}

// The one sentence every topic can honestly carry. It says what is true of
// every surface in the product without claiming the product cannot trade.
const SAFETY_DEFAULT =
  "Nothing in the Help Center can place, change or close a trade. Live dispatch is default-deny: it happens only when your operator has armed it, you are approved and armed, and every Phase B safety gate passes for that specific order.";

const NEVER_ON_YOUR_BEHALF =
  "ARX never opens or closes a position for you without an explicit, gated instruction. Protective auto-close is alert-only.";

export const HELP_TOPICS: HelpTopic[] = [
  // ── Cockpit ──────────────────────────────────────────────────────────────
  { help_key: "cockpit-what-this-page-does", title: "What the Cockpit shows you", category: "COCKPIT", page_route: "/", content: "The cockpit is your home base: your current trading mode, allocation and open trades, today's performance, risk status, alerts, and what the AI is seeing right now — in one place.", safety_note: SAFETY_DEFAULT, related_build: "QQ" },
  { help_key: "cockpit-what-mode-am-i-in", title: "What trading mode am I in?", category: "COCKPIT", page_route: "/my-account", content: "Your mode is one of DISABLED, SIMULATED, DEMO or LIVE. It comes from the platform mode your operator sets, combined with your own trading permission and whether a live account is attached to you. The mode chip in the header is the single source of truth — every page reads the same value. If it says LIVE, orders you approve can reach a real broker.", safety_note: "If you are ever unsure what mode you are in, stop and check the mode chip before approving anything.", related_build: "T003" },
  { help_key: "cockpit-why-an-action-is-disabled", title: "Why an action may be disabled", category: "COCKPIT", page_route: "/", content: "An action is blocked when an unread CRITICAL alert is outstanding, when the Risk Governor has paused or locked your account, when your readiness checks have not passed, or when the trade itself fails a Phase B gate. Use 'Why am I blocked?' in the Help Center — it names the exact system and the exact reason.", safety_note: SAFETY_DEFAULT, related_build: "QQ" },

  // ── Demo / practice ──────────────────────────────────────────────────────
  { help_key: "demo-what-is-demo-execution", title: "What demo execution is", category: "PAPER_SESSION", page_route: "/mt5-setup", content: "Demo execution routes your orders to a demo MT5 account through your own bridge. Fills are real broker fills against demo money — they are not simulated inside ARX, and they are never sent to a live account.", safety_note: "Demo results are not a promise of live results. Spreads, slippage and fills differ on a funded account.", related_build: "PP" },
  { help_key: "demo-readiness", title: "Why demo execution needs a readiness check", category: "PAPER_SESSION", page_route: "/mt5-setup", content: "Before demo execution can be armed, ARX verifies your bridge is connected, the EA heartbeat is fresh, the EA version is recent enough, and the account really is a demo account. Any failure blocks arming and says which check failed.", safety_note: "Arming demo execution never arms live execution. They are separate records with separate gates.", related_build: "PP" },
  { help_key: "demo-vs-live", title: "How demo differs from live", category: "PAPER_SESSION", page_route: "/my-account", content: "Demo and live differ in three ways that matter: the account the order lands on, the size of the loss you can take, and the gate chain. Live adds an operator master switch, an admin approval for you specifically, a signed risk disclosure, and the full 23-gate Phase B evaluation on every single order.", safety_note: SAFETY_DEFAULT, related_build: "PP" },

  // ── Risk ─────────────────────────────────────────────────────────────────
  { help_key: "risk-where-are-my-limits", title: "Where your risk limits live", category: "RISK", page_route: "/risk-command-center", content: "Risk per trade, max daily and weekly loss, max lot size, max open trades and the minimum confidence score are per-user settings. They are enforced before an order is accepted, not after.", safety_note: NEVER_ON_YOUR_BEHALF, related_build: "HH" },
  { help_key: "risk-tighten-now-loosen-later", title: "Why tightening is instant and loosening is not", category: "RISK", page_route: "/risk-command-center", content: "Reducing a risk limit applies the moment you save it. RAISING one does not: it is queued for 24 hours and you must confirm it again afterwards before it takes effect. This exists so a bad hour cannot talk you into a bigger loss. Until you confirm, the OLD, tighter limit is what is in force.", safety_note: "If a screen shows a raised limit as already active before you confirmed it, that screen is wrong — trust the pending-increase list.", related_build: "#42" },
  { help_key: "risk-governor-states", title: "What the Risk Governor states mean", category: "RISK", page_route: "/risk-command-center", content: "ALLOWED — no blocks. CAUTION — warnings you should read. PAUSED — new activity is stopped, usually after a rule breach, and clears when the cooldown expires. WATCH_ONLY — you can watch and review but not open new trades. LOCKED — a hard block is in force and must be resolved before anything opens.", safety_note: SAFETY_DEFAULT, related_build: "HH" },
  { help_key: "risk-daily-loss-limit", title: "What happens at your daily loss limit", category: "RISK", page_route: "/risk-command-center", content: "When realised loss for the day reaches your limit, the DAILY_LOSS_LIMIT_REACHED gate fails and new orders stop. Existing positions are NOT closed for you — the system alerts, it does not liquidate.", safety_note: NEVER_ON_YOUR_BEHALF, related_build: "HH" },
  { help_key: "risk-kill-switch", title: "What the kill switch does", category: "RISK", page_route: "/emergency", content: "The kill switch stops new dispatch immediately. The single documented exception is an emergency CLOSE, which is deliberately allowed through so you are never trapped in a position by your own stop button.", safety_note: "The kill switch does not close your open trades. Closing is still your decision.", related_build: "Ruling 6" },

  // ── Live trading ─────────────────────────────────────────────────────────
  { help_key: "live-can-this-app-trade-live", title: "Can ARX place live orders?", category: "SAFETY", page_route: "/my-account", content: "Yes — on a live-armed account, an order you approve can reach a real broker and risk real money. It is default-deny: nothing dispatches unless your operator has armed live broker execution, an admin has approved YOU for live, you have armed your own account, you have accepted the live risk disclosure, your kill switch is off, and all 23 Phase B gates pass for that specific order.", safety_note: "If your mode chip reads LIVE, treat every confirmation as real money.", related_build: "Phase B" },
  { help_key: "live-the-gate-chain", title: "The gates every live order passes", category: "SAFETY", page_route: "/live-trading", content: "Each order is evaluated against 23 gates before dispatch, including: live execution enabled on the server; you approved and armed; the global live flag on; your kill switch off; the bridge attached to a genuinely live account; a fresh EA heartbeat and a recent enough EA version; algo trading allowed in the terminal; the symbol on your allowed list; volume within your maximum lot; your daily loss limit not reached; a stop-loss and take-profit present; the risk disclosure accepted. A single failing gate blocks the order and names itself.", safety_note: "A blocked order is a correct outcome, not an error.", related_build: "Phase B" },
  { help_key: "live-what-is-not-automatic", title: "What ARX will never do on its own", category: "SAFETY", page_route: "/help", content: "ARX does not open a position without an instruction that passed the gates, does not close a position on your behalf, and never widens a stop. Automatic authority can only ever REDUCE risk, never increase it.", safety_note: NEVER_ON_YOUR_BEHALF, related_build: "AA" },
  { help_key: "live-acknowledgements", title: "What accepting the risk disclosure does", category: "SAFETY", page_route: "/my-account", content: "Accepting the live risk disclosure satisfies exactly one of the 23 gates — DISCLOSURE_NOT_ACCEPTED. It does not approve you for live trading, arm your account, or turn on the operator's master switch. Those are separate, and two of them are not yours to set.", safety_note: SAFETY_DEFAULT, related_build: "Phase B" },

  // ── Broker / bridge ──────────────────────────────────────────────────────
  { help_key: "broker-what-the-bridge-does", title: "What the MT5 bridge does", category: "BROKER", page_route: "/mt5-setup", content: "The bridge is an Expert Advisor running in your MT5 terminal. It reports account state and open positions to ARX, and — when live execution is armed and gated — carries orders the other way. Your bridge token is per-user; ARX stores only its SHA-256 hash and never returns the raw value.", safety_note: "Never paste your bridge token anywhere except your own EA inputs.", related_build: "KK" },
  { help_key: "broker-heartbeat", title: "Why a stale heartbeat blocks trading", category: "BROKER", page_route: "/mt5-setup", content: "If the EA has not checked in recently, ARX cannot tell whether your terminal is still connected or whether an order would even arrive. Rather than guess, it fails the EA_HEARTBEAT_STALE gate and refuses to dispatch.", safety_note: "Not being able to read the state of your bridge is never permission to trade through it.", related_build: "KK" },
  { help_key: "broker-account-mask", title: "Why account IDs are masked", category: "BROKER", page_route: "/my-account", content: "Account identifiers, broker credentials and bridge tokens are masked or redacted everywhere they could be displayed or logged, so an accidental screenshot or support paste cannot expose them.", safety_note: SAFETY_DEFAULT, related_build: "NN" },

  // ── Alerts ───────────────────────────────────────────────────────────────
  { help_key: "alerts-what-cannot-be-silenced", title: "Which alerts cannot be silenced", category: "SAFETY", page_route: "/alert-preferences", content: "You can turn off categories and set quiet hours, and both apply in-app and to push. CRITICAL alerts bypass every one of those switches — a live-risk event, a bridge failure during an open trade, or a broker rejection will reach you regardless of your settings.", safety_note: "If a preference screen offers to silence CRITICAL alerts, it is lying — nothing in ARX can.", related_build: "Phase 10" },
  { help_key: "alerts-where-they-appear", title: "Where your alerts appear", category: "SAFETY", page_route: "/notifications", content: "The bell in the header counts your unread alerts, the drawer behind it lists them, and the Notification Center is the full history. All three read the same per-user store — you only ever see your own.", safety_note: SAFETY_DEFAULT, related_build: "Phase 10" },

  // ── Coach / analysis ─────────────────────────────────────────────────────
  { help_key: "coach-what-it-is", title: "What the AI coach is (and is not)", category: "COACH", page_route: "/ai-coach", content: "The coach describes patterns in your own past behaviour — what you repeated, when you overtraded, which setups you handled well. It is a mirror, not a forecast.", safety_note: "Coach output is educational. It is not financial advice and it does not predict profit.", related_build: "II" },
  { help_key: "coach-sample-size", title: "Why sample size matters", category: "COACH", page_route: "/performance-scorecard", content: "A handful of trades is not statistically meaningful. Expect dozens of consistent results before treating any pattern in your own history as real.", safety_note: "A short winning streak is not evidence of an edge.", related_build: "II" },
  { help_key: "analysis-confidence-scores", title: "What a confidence score means", category: "COACH", page_route: "/market-scanner", content: "A confidence score describes how well the current data matches the conditions a strategy was defined for. It is not a probability of profit, and a high score is not an instruction to trade.", safety_note: "No score on any ARX screen is a prediction that a trade will make money.", related_build: "AA" },

  // ── Backtest / replay ────────────────────────────────────────────────────
  { help_key: "replay-simulation-only", title: "Replay and backtests are simulations", category: "REPLAY", page_route: "/testing-lab", content: "Replay runs strategies over historical candles. Nothing is sent to any broker, demo or live, and no order is created.", safety_note: "A profitable backtest can be a losing live result. Do not size a live position from a replay.", related_build: "JJ" },

  // ── Data ─────────────────────────────────────────────────────────────────
  { help_key: "data-when-the-feed-degrades", title: "What happens when market data degrades", category: "DATA", page_route: "/live-chart", content: "When quotes go stale, spreads blow out or candles are missing, ARX marks the feed degraded and becomes more conservative rather than filling the gap with a guess. A price it cannot verify is shown as unavailable, never as a confident number.", safety_note: "If a price or P&L is shown as unavailable, that is the honest answer — do not treat a blank as zero.", related_build: "DD" },

  // ── General ──────────────────────────────────────────────────────────────
  { help_key: "general-getting-started", title: "Where to start", category: "GENERAL", page_route: "/onboarding", content: "Work through onboarding, then watch ARX Status until your readiness items are green, then practise with demo execution. Live access is granted by your operator — it is not something you can switch on yourself.", safety_note: SAFETY_DEFAULT, related_build: "RR" },
  { help_key: "general-what-arx-status-shows", title: "What ARX Status tells you", category: "READINESS", page_route: "/status-command-center", content: "ARX Status is the honest readout of what is and is not working for your account right now: bridge state, readiness checks, risk posture, and what is blocking you from the next step.", safety_note: SAFETY_DEFAULT, related_build: "OO" },
];

export function findTopic(key: string): HelpTopic | null {
  return HELP_TOPICS.find(t => t.help_key === key) ?? null;
}

export function topicsForRoute(route: string): HelpTopic[] {
  return HELP_TOPICS.filter(t => t.page_route === route);
}
