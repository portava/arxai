// Build RR — Smart Help content + topic resolver. Plain English, paper-only.

export interface HelpTopic {
  help_key: string;
  title: string;
  category: "COCKPIT" | "PAPER_SESSION" | "RISK" | "READINESS" | "COACH" | "REPLAY" | "DATA" | "BROKER" | "SAFETY" | "GENERAL";
  page_route: string | null;
  content: string;
  safety_note: string;
  related_build: string;
}

const SAFETY_DEFAULT = "This app is PAPER_ONLY. Live trading is disabled and cannot be enabled here.";

export const HELP_TOPICS: HelpTopic[] = [
  // Cockpit
  { help_key: "cockpit-what-this-page-does", title: "What the Trading Cockpit does", category: "COCKPIT", page_route: "/trading-cockpit", content: "The cockpit is your home base. It shows safety status, your active paper session, open paper trades, today's performance, coach guidance, alerts, autopilot, and system health — all in one place.", safety_note: SAFETY_DEFAULT, related_build: "QQ" },
  { help_key: "cockpit-how-to-start-safely", title: "How to start safely", category: "COCKPIT", page_route: "/trading-cockpit", content: "1) Acknowledge live trading is disabled. 2) Run readiness. 3) Run preflight. 4) If safe, start a paper session. 5) Monitor and debrief.", safety_note: SAFETY_DEFAULT, related_build: "QQ" },
  { help_key: "cockpit-why-start-disabled", title: "Why a Start button may be disabled", category: "COCKPIT", page_route: "/trading-cockpit", content: "Start is disabled when there is an unread CRITICAL alert, when the Readiness Gate is BLOCKED, when the Risk Governor is PAPER_PAUSED/LOCKED/WATCH_ONLY, or when an active session already exists.", safety_note: SAFETY_DEFAULT, related_build: "QQ" },
  // Paper sessions
  { help_key: "paper-what-is-a-session", title: "What is a paper session?", category: "PAPER_SESSION", page_route: "/paper-testing-launch", content: "A paper session is a controlled practice run. It applies risk rules, time-bounds the practice, and produces a session report. Nothing is sent to a real broker.", safety_note: SAFETY_DEFAULT, related_build: "PP" },
  { help_key: "paper-why-preflight-matters", title: "Why preflight matters", category: "PAPER_SESSION", page_route: "/paper-testing-launch", content: "Preflight asks every safety subsystem (readiness, risk, security, alerts) before letting you start. If any returns BLOCK, the session does not start.", safety_note: SAFETY_DEFAULT, related_build: "PP" },
  { help_key: "paper-session-limits", title: "What session limits mean", category: "PAPER_SESSION", page_route: "/paper-testing-launch", content: "Session limits cap how many paper trades you can open, how long the session lasts, and how much paper loss is allowed before the session pauses itself.", safety_note: SAFETY_DEFAULT, related_build: "PP" },
  // Risk governor
  { help_key: "risk-paper-allowed", title: "What PAPER_ALLOWED means", category: "RISK", page_route: "/risk-settings", content: "Paper trading is fully allowed. There are no current blocks or major warnings.", safety_note: SAFETY_DEFAULT, related_build: "HH" },
  { help_key: "risk-paper-paused", title: "What PAPER_PAUSED means", category: "RISK", page_route: "/risk-settings", content: "Paper trading is temporarily paused, usually because risk rules were violated. Wait for cooldowns to clear or fix the listed flags.", safety_note: SAFETY_DEFAULT, related_build: "HH" },
  { help_key: "risk-watch-only", title: "What WATCH_ONLY means", category: "RISK", page_route: "/risk-settings", content: "You can watch the market and review data, but new paper trades are paused.", safety_note: SAFETY_DEFAULT, related_build: "HH" },
  { help_key: "risk-locked", title: "What LOCKED means", category: "RISK", page_route: "/risk-settings", content: "All paper activity is locked. Resolve the hard blocks listed by the governor.", safety_note: SAFETY_DEFAULT, related_build: "HH" },
  // Readiness
  { help_key: "readiness-pass", title: "What PASS means", category: "READINESS", page_route: "/readiness-checklist", content: "Every readiness check passed. You may paper-test.", safety_note: SAFETY_DEFAULT, related_build: "OO" },
  { help_key: "readiness-pass-warnings", title: "What PASS_WITH_WARNINGS means", category: "READINESS", page_route: "/readiness-checklist", content: "Readiness passed but with warnings. You may paper-test, but read the warnings.", safety_note: SAFETY_DEFAULT, related_build: "OO" },
  { help_key: "readiness-blocked", title: "What BLOCKED means", category: "READINESS", page_route: "/readiness-checklist", content: "A required readiness check failed. Paper sessions are blocked until you fix the listed item(s). Live trading remains disabled.", safety_note: SAFETY_DEFAULT, related_build: "OO" },
  // Coach
  { help_key: "coach-how-to-use", title: "How to use the Coach", category: "COACH", page_route: "/trader-coach", content: "Read the focus, the mistakes to avoid, and the next best actions. Apply them in your next paper session.", safety_note: "Coach guidance is educational. It never recommends live trading.", related_build: "II" },
  { help_key: "coach-sample-size", title: "Why sample size matters", category: "COACH", page_route: "/trader-coach", content: "A handful of paper trades is not statistically meaningful. Aim for dozens of consistent results before trusting any pattern.", safety_note: SAFETY_DEFAULT, related_build: "II" },
  { help_key: "coach-not-prediction", title: "Why this is not profit prediction", category: "COACH", page_route: "/trader-coach", content: "Coach output describes past behaviour. It does not predict profits and is not financial advice.", safety_note: SAFETY_DEFAULT, related_build: "II" },
  // Replay
  { help_key: "replay-simulation-only", title: "Replay is simulation only", category: "REPLAY", page_route: "/replay-simulator", content: "Replay runs strategies on historical candles. It is a simulation. No orders go to any broker.", safety_note: "Replay results do not guarantee future profits.", related_build: "JJ" },
  { help_key: "replay-not-proof", title: "Replay results are not proof of future profits", category: "REPLAY", page_route: "/replay-simulator", content: "A profitable replay can become a losing live result. Use replay to evaluate ideas, not to size live positions (which are disabled here anyway).", safety_note: SAFETY_DEFAULT, related_build: "JJ" },
  // Data
  { help_key: "data-historical", title: "Imported data is historical", category: "DATA", page_route: "/data-import", content: "Imported candles are historical snapshots. They are not live broker data and cannot drive live execution.", safety_note: SAFETY_DEFAULT, related_build: "KK" },
  { help_key: "data-not-live", title: "Imported data is not live market data", category: "DATA", page_route: "/data-import", content: "Imports never connect to a broker for execution. They feed practice tools only.", safety_note: SAFETY_DEFAULT, related_build: "KK" },
  // Broker
  { help_key: "broker-readonly", title: "Read-only means no execution", category: "BROKER", page_route: "/broker-readonly", content: "The broker connector here only reads account/position information. It cannot place, modify, or close orders.", safety_note: SAFETY_DEFAULT, related_build: "KK" },
  { help_key: "broker-account-mask", title: "Why account IDs are masked", category: "BROKER", page_route: "/broker-readonly", content: "Account identifiers and credentials are masked or redacted to prevent accidental exposure.", safety_note: SAFETY_DEFAULT, related_build: "NN" },
  // Safety global
  { help_key: "safety-paper-only", title: "Why the app says live trading is disabled", category: "SAFETY", page_route: null, content: "This build runs in PAPER_ONLY mode. The internal safety core does not allow live order placement under any circumstance.", safety_note: SAFETY_DEFAULT, related_build: "AA" },
  { help_key: "safety-acks-no-unlock", title: "Acknowledgements do not unlock live trading", category: "SAFETY", page_route: null, content: "Safety acknowledgements are required for guided onboarding only. They never grant live-trading permission.", safety_note: SAFETY_DEFAULT, related_build: "RR" },
];

export function findTopic(key: string): HelpTopic | null {
  return HELP_TOPICS.find(t => t.help_key === key) ?? null;
}

export function topicsForRoute(route: string): HelpTopic[] {
  return HELP_TOPICS.filter(t => t.page_route === route);
}
