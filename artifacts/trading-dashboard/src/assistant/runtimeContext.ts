// Runtime context collector. Pure DOM/state read; no side effects.
import { resolveRoute } from "@/knowledge/routeKnowledge";
import type {
  RuntimeContext,
  ViewportMode,
  HealthSummary,
  BridgeDiagnosticSummary,
  RuntimeFetchStatus,
} from "./runtimeContextTypes";
import { getErrors, scrubString } from "./errorBuffer";

const recentEndpoints: string[] = [];
const recentNavFailures: string[] = [];
const recentQuestions: string[] = [];
const recentMissing: string[] = [];

export function recordFailedEndpoint(path: string): void {
  if (!path) return;
  recentEndpoints.push(scrubString(path).split(/[?#]/)[0] || "");
  while (recentEndpoints.length > 10) recentEndpoints.shift();
}
export function recordNavigationFailure(path: string): void {
  recentNavFailures.push(scrubString(path));
  while (recentNavFailures.length > 10) recentNavFailures.shift();
}
export function recordAssistantQuestion(q: string): void {
  if (!q) return;
  recentQuestions.push(scrubString(q).slice(0, 120));
  while (recentQuestions.length > 10) recentQuestions.shift();
}
export function recordMissingKnowledge(label: string): void {
  recentMissing.push(scrubString(label).slice(0, 120));
  while (recentMissing.length > 10) recentMissing.shift();
}

export function detectViewport(): ViewportMode {
  if (typeof window === "undefined") return "desktop";
  const w = window.innerWidth || 1024;
  if (w < 640) return "mobile";
  if (w < 1024) return "tablet";
  return "desktop";
}

function readAttrAll(selector: string, attr: string): string[] {
  if (typeof document === "undefined") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  document.querySelectorAll(selector).forEach((el) => {
    const v = (el as HTMLElement).getAttribute(attr);
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  });
  return out;
}

function readVisibleBadges(): string[] {
  if (typeof document === "undefined") return [];
  const labels = new Set<string>();
  // Explicit data-arx-status badges.
  for (const v of readAttrAll("[data-arx-status]", "data-arx-status")) labels.add(v);
  // Plus any element with data-arx-id starting with "badge-" (legacy).
  document.querySelectorAll('[data-arx-id^="badge-"]').forEach((el) => {
    const t = (el as HTMLElement).innerText?.trim();
    if (t && t.length < 64) labels.add(t);
  });
  return [...labels];
}

function readDisabledControls(): string[] {
  if (typeof document === "undefined") return [];
  const out = new Set<string>();
  document.querySelectorAll<HTMLElement>("[data-arx-id]").forEach((el) => {
    if (el instanceof HTMLButtonElement && el.disabled) {
      const id = el.getAttribute("data-arx-id");
      if (id) out.add(id);
    } else if (el.getAttribute("aria-disabled") === "true") {
      const id = el.getAttribute("data-arx-id");
      if (id) out.add(id);
    }
  });
  return [...out];
}

export interface CollectInputs {
  route: string;
  selectedSymbol?: string | null;
  bridge?: BridgeDiagnosticSummary | null;
  health?: HealthSummary | null;
  serverRoleHint?: RuntimeContext["serverRoleHint"];
  /** How the latest bridge read went; ignored when `bridge` is present. */
  bridgeStatus?: RuntimeFetchStatus;
  /** How the latest health read went; ignored when `health` is present. */
  healthStatus?: RuntimeFetchStatus;
}

/** A server boolean, or null when the field is absent / not a boolean. */
function readBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function fetchStatus(present: boolean, hint: RuntimeFetchStatus | undefined): RuntimeFetchStatus {
  if (present) return "loaded";
  return hint === "loading" ? "loading" : "unavailable";
}

export function collectRuntimeContext(input: CollectInputs): RuntimeContext {
  const route = input.route || (typeof window !== "undefined" ? window.location.pathname : "/");
  const pageTitle = resolveRoute(route)?.title ?? null;
  const viewport = detectViewport();
  const visibleElements = readAttrAll("[data-arx-id]", "data-arx-id");
  const visibleBadges = readVisibleBadges();
  const disabledControls = readDisabledControls();

  // Derive trading-mode flags from the bridge summary (server is source of
  // truth). Without a summary (loading, failed request, missing field) each
  // flag is null = unknown; absent data is never turned into a safe default.
  const bridge = input.bridge ?? null;
  const liveTradingEnabled = readBool(bridge?.liveTradingEnabled);
  const brokerExecutionEnabled = readBool(bridge?.brokerExecutionEnabled);
  const liveTradingDisabled = liveTradingEnabled === null ? null : !liveTradingEnabled;
  const brokerExecutionDisabled = brokerExecutionEnabled === null ? null : !brokerExecutionEnabled;
  const brokerReadOnly = readBool(bridge?.brokerReadOnly);
  const mt5Deferred = bridge?.bridgeMode === "deferred" || bridge?.bridgeMode === "unknown";
  const mt5BridgeConnected = bridge?.bridgeMode === "connected";
  const heartbeatPresent = readBool(bridge?.heartbeatPresent);
  const heartbeatAgeSeconds = bridge?.heartbeatAgeSeconds ?? null;
  const paperOnly = readBool(bridge?.paperOnly);
  const simulatorMode = bridge ? bridge.bridgeMode === "simulator" || bridge.bridgeMode === "deferred" : null;

  const tradingMode: RuntimeContext["tradingMode"] =
    liveTradingDisabled === null ? "unknown"
      : !liveTradingDisabled ? "live"
        : mt5BridgeConnected && brokerReadOnly === true ? "broker-readonly"
          : simulatorMode === true ? "simulator"
            : paperOnly === true ? "paper" : "unknown";

  const activeSafetyLocks: string[] = [];
  if (liveTradingDisabled === true) activeSafetyLocks.push("LIVE TRADING DISABLED");
  if (brokerExecutionDisabled === true) activeSafetyLocks.push("BROKER EXECUTION DISABLED");
  if (brokerReadOnly === true) activeSafetyLocks.push("BROKER READ-ONLY");
  if (mt5Deferred) activeSafetyLocks.push("MT5 DEFERRED");
  if (paperOnly === true) activeSafetyLocks.push("DEMO ONLY");
  if (simulatorMode === true) activeSafetyLocks.push("SIMULATOR MODE");

  return {
    capturedAt: new Date().toISOString(),
    route,
    pageTitle,
    viewport,
    visibleElements,
    visibleBadges,
    activeSafetyLocks,
    disabledControls,
    selectedSymbol: input.selectedSymbol ?? null,
    tradingMode,
    paperOnly,
    simulatorMode,
    liveTradingDisabled,
    brokerExecutionDisabled,
    brokerReadOnly,
    mt5Deferred,
    mt5BridgeConnected,
    heartbeatPresent,
    heartbeatAgeSeconds,
    // No endpoint this collector reads reports the platform emergency stop or
    // the kill switch, so its state is unknown here — never a measured "off".
    emergencyStopActive: null,
    readiness: input.health && input.health.readinessReachable ? "unknown" : "unknown",
    serverRoleHint: input.serverRoleHint ?? "unknown",
    recentErrors: getErrors(),
    recentFailedEndpoints: recentEndpoints.slice(),
    recentNavigationFailures: recentNavFailures.slice(),
    recentAssistantQuestions: recentQuestions.slice(),
    missingKnowledgeFallbacks: recentMissing.slice(),
    health: input.health ?? null,
    bridge,
    bridgeStatus: fetchStatus(bridge !== null, input.bridgeStatus),
    healthStatus: fetchStatus(input.health != null, input.healthStatus),
  };
}

/** Build a safe diagnostic context object suitable to attach to a bug report. */
export function buildSafeReportContext(ctx: RuntimeContext, diagnosisCategory?: string): Record<string, unknown> {
  return {
    route: ctx.route,
    viewport: ctx.viewport,
    visibleStatuses: ctx.activeSafetyLocks,
    activeBlockers: ctx.disabledControls,
    safeErrorSummaries: ctx.recentErrors.slice(-5).map((e) => ({
      kind: e.kind, message: e.message, path: e.path, status: e.status, ts: e.ts,
    })),
    failedEndpoints: ctx.recentFailedEndpoints.slice(-5),
    diagnosisCategory: diagnosisCategory ?? null,
    tradingMode: ctx.tradingMode,
    bridgeMode: ctx.bridge?.bridgeMode ?? "unknown",
    heartbeatPresent: ctx.heartbeatPresent,
    capturedAt: ctx.capturedAt,
  };
}
