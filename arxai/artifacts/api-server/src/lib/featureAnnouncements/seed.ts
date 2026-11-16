// Seed announcements ONLY for features that actually exist in this app.
// Do not seed announcements for features that are not built — that would
// teach users about non-existent functionality.

export interface SeedAnnouncement {
  featureKey: string;
  version: string;
  title: string;
  body: string;
  route: string | null;
  severity: "info" | "warning" | "critical";
}

export const SEED_ANNOUNCEMENTS: SeedAnnouncement[] = [
  {
    featureKey: "live-trading-control-locked",
    version: "1",
    title: "Live Trading Control Center (LOCKED)",
    body: "A new safety-locked control center for live trading is available at /live-trading-control. The system is intentionally LOCKED — no live orders can be placed because no broker integration is configured. The page lets you review readiness, kill-switch state, and the 25 safety checks every order would have to pass.",
    route: "/live-trading-control",
    severity: "info",
  },
  {
    featureKey: "paper-sessions",
    version: "1",
    title: "Controlled Paper Sessions",
    body: "You can run controlled paper trading sessions with full decision logging. Every signal, approval, rejection, and warning is recorded. Live tables are never touched.",
    route: "/paper-testing-launch",
    severity: "info",
  },
  {
    featureKey: "risk-governor",
    version: "1",
    title: "Risk Governor",
    body: "The Risk Governor watches your paper activity and pauses sessions when rules are violated (max drawdown, losing streak, spread, confidence, etc.).",
    route: "/risk-settings",
    severity: "info",
  },
  {
    featureKey: "trading-calendar",
    version: "1",
    title: "Trading Calendar",
    body: "Daily P&L, winning days, and losing days are now visible on a calendar so you can spot patterns over time.",
    route: "/trading-calendar",
    severity: "info",
  },
  {
    featureKey: "trade-journal",
    version: "1",
    title: "Trade Journal",
    body: "Every paper trade is logged with entry, exit, P&L, and reason. Use the journal to review past decisions.",
    route: "/journal",
    severity: "info",
  },
  {
    featureKey: "learning-loop",
    version: "1",
    title: "Learning Loop",
    body: "The learning engine reviews paper outcomes and surfaces patterns (mistake patterns, strategy edges) to improve future decisions.",
    route: "/learning",
    severity: "info",
  },
  {
    featureKey: "audit-log",
    version: "1",
    title: "Audit Log",
    body: "Every safety-relevant action — kill switch, mode change, arming attempt, acknowledgement — is recorded in the append-only audit vault.",
    route: "/audit-log",
    severity: "info",
  },
  {
    featureKey: "kill-switch",
    version: "1",
    title: "Emergency Kill Switch",
    body: "The kill switch is the big red button. It blocks all new live orders, stops any autopilot, and returns the system to a safe READ_ONLY state. It is ON by default.",
    route: "/emergency",
    severity: "warning",
  },
  {
    featureKey: "help-center",
    version: "1",
    title: "Help Center",
    body: "Plain-English explanations for every page, every safety check, and every reason a trade was blocked. Click Help anytime.",
    route: "/help",
    severity: "info",
  },
  {
    featureKey: "system-health",
    version: "1",
    title: "System Health",
    body: "See the live status of every safety subsystem in one place.",
    route: "/system-health",
    severity: "info",
  },
];
