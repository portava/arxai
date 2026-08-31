// Build RR — Onboarding step definitions. Plain English.
//
// HONESTY: this catalogue used to tell every user — including live-armed
// ones — that "this app cannot enable live trading" and that a LIVE TRADING
// DISABLED badge "is always shown". Live dispatch really exists on this build
// (lib/live/liveCommandPipeline.ts), gated default-deny behind operator and
// admin approvals. The copy below states that truth: onboarding itself never
// places trades and never changes your mode; live trading is possible but
// admin-gated and never unlockable from here.
//
// STALE ROUTES (same defect help.ts fixed as RANK 51): the catalogue also
// routed REQUIRED steps at pages that no longer exist (/trading-cockpit and
// /paper-testing-launch were unmounted in Phase 3) and at admin-only surfaces
// on no trader allowlist (/readiness-checklist, /risk-settings,
// /session-report, /replay-simulator, /data-import, /system-health,
// /trader-coach) — so RouteAccessGuard silently bounced every such "Open …"
// click back home. Every page_route below is now a real <Route> reachable by
// a human trader (null = no trader-reachable page, so no link is offered),
// and the onboarding page additionally re-checks each route against the
// viewer's own tier before rendering the link (useCanOpenRoute), exactly as
// the Help Center does. Copy that described the retired paper-session flow
// ("the Trading Cockpit", "paper sessions") now describes the surfaces that
// exist: the cockpit home at "/", ARX Status, and demo execution.

export type ActionType = "READ" | "CLICK" | "CONFIRM" | "COMPLETE_ACTION";

export interface OnboardingStep {
  step_id: string;
  title: string;
  description: string;
  /** Must be a real route reachable by a human trader tier. null = no page. */
  page_route: string | null;
  target_component: string;
  action_type: ActionType;
  required: boolean;
  completion_condition: string;
  help_text: string;
  safety_note: string;
}

const SAFETY = "This onboarding step never places real trades and never changes your trading mode. Live trading is separate, default-deny, and operator/admin-gated.";

export const ONBOARDING_STEPS: OnboardingStep[] = [
  { step_id: "welcome", title: "Welcome to ARX", description: "Onboarding walks you through the practice surfaces. Nothing in onboarding places real trades. Your trading mode (Off / Demo / Live) is set by your admin — check the mode chip in the header for what yours is right now.", page_route: "/onboarding", target_component: "WelcomeCard", action_type: "READ", required: true, completion_condition: "User clicks Continue.", help_text: "Practice in demo/simulator first. If your mode chip ever reads LIVE, orders you approve can reach a real broker.", safety_note: SAFETY },
  { step_id: "ack-live-disabled", title: "Confirm Live Trading Is Admin-Gated", description: "Acknowledge that live trading is default-deny and only enabled by operator/admin approval — you cannot unlock it from onboarding or from any acknowledgement.", page_route: "/onboarding", target_component: "SafetyAck", action_type: "CONFIRM", required: true, completion_condition: "live_disabled_acknowledged = true", help_text: "Acknowledgements are stored, but they NEVER unlock live trading.", safety_note: SAFETY },
  { step_id: "safety-header", title: "Understand the Safety Header", description: "The safety header at the top of every ARX page shows readiness, risk, security, alerts, and session status. Review what each badge means.", page_route: "/", target_component: "SafetyHeader", action_type: "READ", required: true, completion_condition: "User views the safety header.", help_text: "Green = safe. Amber = warning. Red = blocked.", safety_note: SAFETY },
  { step_id: "readiness-check", title: "Run a Readiness Check", description: "ARX Status is the honest readout of your account's readiness checks. PASS or PASS_WITH_WARNINGS means you may practise in demo.", page_route: "/status-command-center", target_component: "ReadinessRunner", action_type: "CLICK", required: true, completion_condition: "User has viewed their readiness readout on ARX Status.", help_text: "If readiness BLOCKS, fix the listed items. Passing readiness never by itself enables live trading — that stays operator/admin-gated.", safety_note: SAFETY },
  { step_id: "preflight", title: "Check Demo Execution Readiness", description: "Before demo execution can be armed, ARX verifies your bridge is connected, the EA heartbeat is fresh, and the account really is a demo account.", page_route: "/mt5-setup", target_component: "PreflightButton", action_type: "CLICK", required: true, completion_condition: "Demo readiness checks returned an answer.", help_text: "If a check fails, the MT5 Setup page tells you exactly what to fix. Arming demo execution never arms live execution.", safety_note: SAFETY },
  { step_id: "start-session", title: "Practise With Demo Execution", description: "Once demo execution is armed, orders you approve route to your demo MT5 account — real broker fills against demo money, never a live account.", page_route: "/mt5-setup", target_component: "StartSessionForm", action_type: "COMPLETE_ACTION", required: false, completion_condition: "Demo execution has been used at least once.", help_text: "Demo results are not a promise of live results.", safety_note: SAFETY },
  { step_id: "risk-governor", title: "Read the Risk Governor", description: "The Risk Governor watches your trading and pauses new activity if you violate rules. Your risk limits live in the Risk Command Center.", page_route: "/risk-command-center", target_component: "RiskGovernorPanel", action_type: "READ", required: true, completion_condition: "User opens the Risk Command Center.", help_text: "ALLOWED, CAUTION, PAUSED, WATCH_ONLY, LOCKED — a block names its reason.", safety_note: SAFETY },
  { step_id: "critical-alerts", title: "Review Critical Alerts", description: "Critical alerts must be acknowledged before starting a new session.", page_route: "/notifications", target_component: "AlertList", action_type: "READ", required: true, completion_condition: "User opens the Notifications page.", help_text: "Critical alerts are safety messages, not trade tips.", safety_note: SAFETY },
  { step_id: "monitor-trades", title: "Monitor Open Trades", description: "Open trades show on the cockpit home with entry, stop, target, and unrealised P&L.", page_route: "/", target_component: "OpenTradesPanel", action_type: "READ", required: false, completion_condition: "User views the open trades panel.", help_text: "In demo mode these are demo-account positions. If your mode chip reads LIVE, they are real.", safety_note: SAFETY },
  { step_id: "coach", title: "Read Coach Guidance", description: "The AI Coach turns your own trading history into plain-English next steps.", page_route: "/ai-coach", target_component: "CoachReport", action_type: "READ", required: false, completion_condition: "User opens the AI Coach page.", help_text: "Coach feedback is educational; it never recommends live trading.", safety_note: SAFETY },
  { step_id: "end-session", title: "Review Your Performance", description: "The Performance Scorecard turns your closed trades into ratings, mistakes, and lessons.", page_route: "/performance-scorecard", target_component: "SessionReport", action_type: "COMPLETE_ACTION", required: false, completion_condition: "User opens the Performance Scorecard.", help_text: "Read the review before your next trading day.", safety_note: SAFETY },
  { step_id: "replay", title: "Try Replay in the Testing Lab", description: "The Testing Lab replays strategies against historical candles. Results are simulation only — nothing is sent to any broker.", page_route: "/testing-lab", target_component: "ReplayRunner", action_type: "READ", required: false, completion_condition: "User opens the Testing Lab.", help_text: "Past performance does not guarantee future results.", safety_note: SAFETY },
  { step_id: "strategy-lab", title: "Try the Strategy Lab", description: "Strategy Lab evaluates strategies in a sandbox. The lab itself never executes orders, live or demo.", page_route: "/strategy-lab", target_component: "StrategyLab", action_type: "READ", required: false, completion_condition: "User opens Strategy Lab.", help_text: "Strategy results are educational only.", safety_note: SAFETY },
  { step_id: "data-import", title: "Understand Data Imports", description: "Data imports are operator-managed. Imported data is historical and is never treated as a live broker connection.", page_route: null, target_component: "DataImport", action_type: "READ", required: false, completion_condition: "User has read what data imports are.", help_text: "Imports never change live broker permissions.", safety_note: SAFETY },
  { step_id: "system-health", title: "Review ARX Status", description: "ARX Status shows the state of every safety subsystem for your account.", page_route: "/status-command-center", target_component: "HealthOverview", action_type: "READ", required: false, completion_condition: "User opens ARX Status.", help_text: "DEGRADED is a warning, not a permission to live-trade.", safety_note: SAFETY },
  { step_id: "complete", title: "Complete Onboarding", description: "Mark onboarding complete. The cockpit home page is your home base from here on.", page_route: "/onboarding", target_component: "CompleteCard", action_type: "CONFIRM", required: true, completion_condition: "walkthrough_completed = true", help_text: "You can re-run onboarding any time from the Help Center.", safety_note: SAFETY },
];

export const REQUIRED_ACK_KEYS = ["paperOnlyAcknowledged", "liveDisabledAcknowledged", "riskDisclaimerAcknowledged", "replaySimulationAcknowledged", "brokerReadonlyAcknowledged"] as const;
export type AckKey = typeof REQUIRED_ACK_KEYS[number];
