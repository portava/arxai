// Build RR — Onboarding step definitions. Plain English. PAPER_ONLY.

export type ActionType = "READ" | "CLICK" | "CONFIRM" | "COMPLETE_ACTION";

export interface OnboardingStep {
  step_id: string;
  title: string;
  description: string;
  page_route: string;
  target_component: string;
  action_type: ActionType;
  required: boolean;
  completion_condition: string;
  help_text: string;
  safety_note: string;
}

const SAFETY = "Live trading is disabled. This step never places real trades.";

export const ONBOARDING_STEPS: OnboardingStep[] = [
  { step_id: "welcome", title: "Welcome to Paper Mode", description: "This app is a paper-only practice environment for trading. Nothing here can place real trades.", page_route: "/onboarding", target_component: "WelcomeCard", action_type: "READ", required: true, completion_condition: "User clicks Continue.", help_text: "Paper mode lets you practice without risk. Every order is simulated.", safety_note: SAFETY },
  { step_id: "ack-live-disabled", title: "Confirm Live Trading Is Disabled", description: "Acknowledge that this app cannot enable live trading. The LIVE TRADING DISABLED badge is always shown.", page_route: "/onboarding", target_component: "SafetyAck", action_type: "CONFIRM", required: true, completion_condition: "live_disabled_acknowledged = true", help_text: "Acknowledgements are stored, but they NEVER unlock live trading.", safety_note: SAFETY },
  { step_id: "safety-header", title: "Understand the Safety Header", description: "The cockpit safety header shows readiness, risk governor, security, alerts, and session status. Review what each badge means.", page_route: "/trading-cockpit", target_component: "SafetyHeader", action_type: "READ", required: true, completion_condition: "User views the cockpit safety header.", help_text: "Green = safe. Amber = warning. Red = blocked.", safety_note: SAFETY },
  { step_id: "readiness-check", title: "Run a Readiness Check", description: "The Readiness Gate scores your system on 6 areas. PASS or PASS_WITH_WARNINGS means you may paper-test.", page_route: "/readiness-checklist", target_component: "ReadinessRunner", action_type: "CLICK", required: true, completion_condition: "Readiness Gate report exists.", help_text: "If readiness BLOCKS, fix the listed items. Live trading remains disabled regardless.", safety_note: SAFETY },
  { step_id: "preflight", title: "Run Paper Session Preflight", description: "Preflight asks every safety subsystem if a paper session is allowed right now.", page_route: "/paper-testing-launch", target_component: "PreflightButton", action_type: "CLICK", required: true, completion_condition: "Preflight returned an answer.", help_text: "If preflight blocks, the cockpit will tell you exactly what to fix.", safety_note: SAFETY },
  { step_id: "start-session", title: "Start a Paper Session", description: "Start a controlled paper session. You will choose symbols, timeframes, and goals.", page_route: "/paper-testing-launch", target_component: "StartSessionForm", action_type: "COMPLETE_ACTION", required: false, completion_condition: "An ACTIVE paper session exists.", help_text: "Only one active session can exist at a time.", safety_note: SAFETY },
  { step_id: "risk-governor", title: "Read the Risk Governor", description: "The Risk Governor watches your trading and pauses paper activity if you violate rules.", page_route: "/risk-settings", target_component: "RiskGovernorPanel", action_type: "READ", required: true, completion_condition: "User opens the Risk Governor page.", help_text: "PAPER_ALLOWED, PAPER_CAUTION, PAPER_PAUSED, WATCH_ONLY, LOCKED — all paper-only.", safety_note: SAFETY },
  { step_id: "critical-alerts", title: "Review Critical Alerts", description: "Critical alerts must be acknowledged before starting a new session.", page_route: "/notifications", target_component: "AlertList", action_type: "READ", required: true, completion_condition: "User opens the Notifications page.", help_text: "Critical alerts are safety messages, not trade tips.", safety_note: SAFETY },
  { step_id: "monitor-trades", title: "Monitor Paper Trades", description: "Open paper trades show in the cockpit with entry, stop, target, and unrealised P&L.", page_route: "/trading-cockpit", target_component: "OpenTradesPanel", action_type: "READ", required: false, completion_condition: "User views the open trades panel.", help_text: "These are simulated and do not exist at any broker.", safety_note: SAFETY },
  { step_id: "coach", title: "Read Coach Guidance", description: "The Coach turns your paper results into plain-English next steps.", page_route: "/trader-coach", target_component: "CoachReport", action_type: "READ", required: false, completion_condition: "User opens the Coach page.", help_text: "Coach feedback is educational; it never recommends live trading.", safety_note: SAFETY },
  { step_id: "end-session", title: "End Session and Review the Report", description: "Ending the session generates a session report with rating, mistakes, and lessons.", page_route: "/session-report", target_component: "SessionReport", action_type: "COMPLETE_ACTION", required: false, completion_condition: "A session report has been generated.", help_text: "Read the report before starting another session.", safety_note: SAFETY },
  { step_id: "replay", title: "Try the Replay Simulator", description: "Replay lets you test setups against historical candles. Results are simulation only.", page_route: "/replay-simulator", target_component: "ReplayRunner", action_type: "READ", required: false, completion_condition: "User opens Replay Simulator.", help_text: "Past performance does not guarantee future results.", safety_note: SAFETY },
  { step_id: "strategy-lab", title: "Try the Strategy Lab", description: "Strategy Lab evaluates strategies in a sandbox. No live execution is possible.", page_route: "/strategy-lab", target_component: "StrategyLab", action_type: "READ", required: false, completion_condition: "User opens Strategy Lab.", help_text: "Strategy results are educational only.", safety_note: SAFETY },
  { step_id: "data-import", title: "Import Data Safely", description: "Imported data is historical and is never treated as a live broker connection.", page_route: "/data-import", target_component: "DataImport", action_type: "READ", required: false, completion_condition: "User opens Data Import.", help_text: "Imports never change live broker permissions.", safety_note: SAFETY },
  { step_id: "system-health", title: "Review System Health", description: "System Health shows the status of every safety subsystem.", page_route: "/system-health", target_component: "HealthOverview", action_type: "READ", required: false, completion_condition: "User opens System Health.", help_text: "DEGRADED is a warning, not a permission to live-trade.", safety_note: SAFETY },
  { step_id: "complete", title: "Complete Onboarding", description: "Mark onboarding complete. The cockpit is your home base from here on.", page_route: "/onboarding", target_component: "CompleteCard", action_type: "CONFIRM", required: true, completion_condition: "walkthrough_completed = true", help_text: "You can re-run onboarding any time from the Help Center.", safety_note: SAFETY },
];

export const REQUIRED_ACK_KEYS = ["paperOnlyAcknowledged", "liveDisabledAcknowledged", "riskDisclaimerAcknowledged", "replaySimulationAcknowledged", "brokerReadonlyAcknowledged"] as const;
export type AckKey = typeof REQUIRED_ACK_KEYS[number];
