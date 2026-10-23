// Runtime context collector. Pure DOM/state read; no side effects.
import { resolveRoute } from "@/knowledge/routeKnowledge";
import type {
  RuntimeContext,
  ViewportMode,
  HealthSummary,
  BridgeDiagnosticSummary,
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
}

export function collectRuntimeContext(input: CollectInputs): RuntimeContext {
  const route = input.route || (typeof window !== "undefined" ? window.location.pathname : "/");
  const pageTitle = resolveRoute(route)?.title ?? null;
  const viewport = detectViewport();
  const visibleElements = readAttrAll("[data-arx-id]", "data-arx-id");
  const visibleBadges = readVisibleBadges();
  const disabledControls = readDisabledControls();

  // Derive trading-mode flags from the bridge summary (server is source of truth).
  const liveTradingDisabled = !(input.bridge?.liveTradingEnabled ?? false);
  const brokerExecutionDisabled = !(input.bridge?.brokerExecutionEnabled ?? false);
  const brokerReadOnly = input.bridge?.brokerReadOnly ?? true;
  const mt5Deferred = input.bridge?.bridgeMode === "deferred" || input.bridge?.bridgeMode === "unknown";
  const mt5BridgeConnected = input.bridge?.bridgeMode === "connected";
  const heartbeatPresent = input.bridge?.heartbeatPresent ?? false;
  const heartbeatAgeSeconds = input.bridge?.heartbeatAgeSeconds ?? null;
  const paperOnly = input.bridge?.paperOnly ?? true;
  const simulatorMode = input.bridge?.bridgeMode === "simulator" || input.bridge?.bridgeMode === "deferred";

  const tradingMode: RuntimeContext["tradingMode"] =
    !liveTradingDisabled ? "live"
      : mt5BridgeConnected && brokerReadOnly ? "broker-readonly"
        : simulatorMode ? "simulator"
          : paperOnly ? "paper" : "unknown";

  const activeSafetyLocks: string[] = [];
  if (liveTradingDisabled) activeSafetyLocks.push("LIVE TRADING DISABLED");
  if (brokerExecutionDisabled) activeSafetyLocks.push("BROKER EXECUTION DISABLED");
  if (brokerReadOnly) activeSafetyLocks.push("BROKER READ-ONLY");
  if (mt5Deferred) activeSafetyLocks.push("MT5 DEFERRED");
  if (paperOnly) activeSafetyLocks.push("DEMO ONLY");
  if (simulatorMode) activeSafetyLocks.push("SIMULATOR MODE");

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
    emergencyStopActive: false, // surfaced by bridge if/when server exposes it
    readiness: input.health && input.health.readinessReachable ? "unknown" : "unknown",
    serverRoleHint: input.serverRoleHint ?? "unknown",
    recentErrors: getErrors(),
    recentFailedEndpoints: recentEndpoints.slice(),
    recentNavigationFailures: recentNavFailures.slice(),
    recentAssistantQuestions: recentQuestions.slice(),
    missingKnowledgeFallbacks: recentMissing.slice(),
    health: input.health ?? null,
    bridge: input.bridge ?? null,
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
