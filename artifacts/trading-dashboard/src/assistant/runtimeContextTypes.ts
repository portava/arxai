// Runtime Context Types — what the App Doctor sees about the live app.
// Diagnostic only. Never carries secrets, tokens, account passwords, or auth.

export type ViewportMode = "mobile" | "tablet" | "desktop";

export type BridgeMode =
  | "deferred"
  | "simulator"
  | "connected"
  | "disconnected"
  | "unknown";

export interface SafeFrontendError {
  ts: string;
  kind: "uncaught" | "react-render" | "fetch" | "route-load" | "import" | "assistant" | "ui-overlap";
  /** Scrubbed, short message (no tokens, no full URLs with query). */
  message: string;
  /** Path-only URL when relevant (no query, no hash). */
  path?: string;
  /** HTTP status when relevant. */
  status?: number;
}

export interface HealthSummary {
  serverReachable: boolean;
  databaseReachable: boolean | null;
  authDetected: boolean;
  feedbackHealthy: boolean;
  mt5BridgeReachable: boolean;
  readinessReachable: boolean;
  riskReachable: boolean;
  simulatorReachable: boolean;
  recentSafeServerErrorCount: number;
  buildTimestamp: string | null;
  /** Round-trip latency to /api/healthz, in ms. */
  healthLatencyMs: number | null;
  fetchedAt: string;
}

export interface BridgeDiagnosticSummary {
  bridgeMode: BridgeMode;
  heartbeatPresent: boolean;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  brokerExecutionEnabled: boolean;
  brokerReadOnly: boolean;
  liveTradingEnabled: boolean;
  paperOnly: boolean;
  safestNextStep: string;
  reason: string;
  fetchedAt: string;
}

export interface RuntimeContext {
  /** Wall-clock when context was captured. */
  capturedAt: string;
  route: string;
  pageTitle: string | null;
  viewport: ViewportMode;
  /** ARX UI elements visible on the page (data-arx-id attribute). */
  visibleElements: string[];
  /** Visible status badges (data-arx-status attribute or known label). */
  visibleBadges: string[];
  /** Active safety locks (e.g. "LIVE TRADING DISABLED", "MT5 DEFERRED"). */
  activeSafetyLocks: string[];
  /** Disabled controls visible on the page (data-arx-id of buttons[disabled]). */
  disabledControls: string[];

  selectedSymbol: string | null;
  tradingMode: "paper" | "simulator" | "broker-readonly" | "live" | "unknown";
  paperOnly: boolean;
  simulatorMode: boolean;
  liveTradingDisabled: boolean;
  brokerExecutionDisabled: boolean;
  brokerReadOnly: boolean;
  mt5Deferred: boolean;
  mt5BridgeConnected: boolean;
  heartbeatPresent: boolean;
  heartbeatAgeSeconds: number | null;
  /**
   * Real kill-switch state read from /api/system/status (safety_core).
   * true = engaged, false = confirmed off, null = the read failed or has not
   * completed — consumers must render null as "unknown", never as "off".
   */
  emergencyStopActive: boolean | null;
  /** Free-form readiness label, e.g. "incomplete" / "ready" / "unknown". */
  readiness: "ready" | "incomplete" | "unknown";

  /** Server-supplied role hint when known (UI never asserts elevated roles). */
  serverRoleHint: "owner" | "admin" | "tester" | "user" | "unknown";

  recentErrors: SafeFrontendError[];
  recentFailedEndpoints: string[];
  recentNavigationFailures: string[];
  recentAssistantQuestions: string[];
  missingKnowledgeFallbacks: string[];

  health: HealthSummary | null;
  bridge: BridgeDiagnosticSummary | null;
}

export type DoctorIssueCategory =
  | "ui-layout"
  | "route-navigation"
  | "permission"
  | "missing-setup"
  | "safety-lock"
  | "mt5-bridge"
  | "heartbeat"
  | "broker-mode"
  | "readiness"
  | "paper-blocker"
  | "simulator-mode"
  | "backend-api"
  | "unknown";

export interface DoctorDiagnosis {
  category: DoctorIssueCategory;
  /** Stable id for tests / source attribution. */
  id: string;
  /** Plain-English explanation. */
  explanation: string;
  /** Short bullet evidence strings drawn from runtime context. */
  evidence: string[];
  likelyCause: string;
  /** Safe next step (never "enable live trading"). */
  safeNextStep: string;
  /** Optional in-app route the user can open. Must resolve via routeKnowledge. */
  relatedRoute?: string;
  /** What the user should NOT do. */
  doNotDo: string;
  /** True when this diagnosis has no effect on live trading availability. */
  liveTradingStillUnavailable: boolean;
  /** Priority (lower = fix first). */
  priority: number;
}
