// Phase 23 — Canonical safety-alert catalog.
//
// The legacy rule generators in `./rules.ts` are organized by source-build
// (HH/AA/BB/…). The Alerts + Notifications phase spec names 18 specific
// safety-alert rule TYPES that must be addressable by name. This module is
// a thin wrapper around the existing `notify()` service that maps each
// spec-named alert to a canonical NotifyInput with a stable dedupe key,
// cooldown window, and the required honest safety language.
//
// SAFETY:
// - Pure additive. Does NOT remove or rewrite any existing rule.
// - NEVER places, modifies, cancels, or closes a trade.
// - NEVER returns or stores any secret (VAPID, MT5 token, session secret).
// - AI close warnings ALWAYS include the canonical disclaimer
//   "AI alert only — review manually. No trade was closed."
// - Auto-close alerts ALWAYS state "Alert only — no trade was executed."
// - All alerts route through `notify()` so the existing dedupe + scrub +
//   preference gates (CRITICAL bypasses) apply uniformly.

import { notify, type NotifyResult } from "./service.js";
import type { NotifyInput, NotifSeverity, NotifType, SourceBuild } from "./rules.js";

/** Canonical safety-alert vocabulary (spec Phase 23 §D). */
export type SafetyAlertKind =
  | "market_data_stale"
  | "market_data_unavailable"
  | "scanner_offline"
  | "candles_unavailable"
  | "bridge_offline"
  | "bridge_heartbeat_stale"
  | "broker_balance_unavailable"
  | "command_blocked"
  | "command_execution_disabled"
  | "auto_close_alert_only"
  | "activity_unknown"
  | "risk_limit_near"
  | "risk_limit_breached"
  | "trade_near_stop_loss"
  | "trade_near_take_profit"
  | "tp_targets_unavailable"
  | "ai_close_warning"
  | "duplicate_action_blocked";

interface CatalogEntry {
  notifType: NotifType;
  severity: NotifSeverity;
  sourceBuild: SourceBuild;
  title: string;
  /** Time-bucket size in ms. Same (kind, scope, bucket) folds into one notification. */
  cooldownMs: number;
  /** Suffix appended to message to keep wording honest. */
  honestSuffix?: string;
}

const SIXTY_SECONDS = 60_000;
const FIVE_MINUTES = 5 * 60_000;
const FIFTEEN_MINUTES = 15 * 60_000;

// Frozen at runtime so no consumer can mutate severity / suffix and weaken
// the honest-language guarantee at runtime.
const CATALOG: Readonly<Record<SafetyAlertKind, Readonly<CatalogEntry>>> = Object.freeze({
  market_data_stale: {
    notifType: "DATA", severity: "WARNING", sourceBuild: "LL",
    title: "Market data stale",
    cooldownMs: FIVE_MINUTES,
    honestSuffix: "Alert only — analysis paused until live data resumes.",
  },
  market_data_unavailable: {
    notifType: "DATA", severity: "WARNING", sourceBuild: "LL",
    title: "Market data unavailable",
    cooldownMs: FIVE_MINUTES,
    honestSuffix: "Alert only — no analysis ran. No trade was executed.",
  },
  scanner_offline: {
    notifType: "DATA", severity: "WARNING", sourceBuild: "LL",
    title: "Scanner offline",
    cooldownMs: FIVE_MINUTES,
    honestSuffix: "Alert only — scanner candidates are unavailable.",
  },
  candles_unavailable: {
    notifType: "DATA", severity: "INFO", sourceBuild: "LL",
    title: "Candles unavailable",
    cooldownMs: FIVE_MINUTES,
    honestSuffix: "Alert only — no fabricated OHLC was returned.",
  },
  bridge_offline: {
    notifType: "BROKER", severity: "WARNING", sourceBuild: "LL",
    title: "Bridge offline",
    cooldownMs: FIVE_MINUTES,
    honestSuffix: "Alert only — MT5 bridge is not connected. No command can be sent.",
  },
  bridge_heartbeat_stale: {
    notifType: "BROKER", severity: "WARNING", sourceBuild: "LL",
    title: "Bridge heartbeat stale",
    cooldownMs: FIVE_MINUTES,
    honestSuffix: "Alert only — last EA heartbeat is older than the freshness window.",
  },
  broker_balance_unavailable: {
    notifType: "BROKER", severity: "INFO", sourceBuild: "LL",
    title: "Broker balance unavailable",
    cooldownMs: FIFTEEN_MINUTES,
    honestSuffix: "Alert only — balance/equity could not be read.",
  },
  command_blocked: {
    notifType: "SAFETY", severity: "WARNING", sourceBuild: "LL",
    title: "Command blocked by safety gate",
    cooldownMs: SIXTY_SECONDS,
    honestSuffix: "Alert only — the command was not delivered to the broker.",
  },
  command_execution_disabled: {
    notifType: "SAFETY", severity: "INFO", sourceBuild: "LL",
    title: "Command execution disabled",
    cooldownMs: FIFTEEN_MINUTES,
    honestSuffix: "Alert only — command execution is intentionally locked in this build.",
  },
  auto_close_alert_only: {
    notifType: "SAFETY", severity: "INFO", sourceBuild: "LL",
    title: "Protective auto-close in ALERT_ONLY",
    cooldownMs: FIFTEEN_MINUTES,
    honestSuffix: "Alert only — no trade was executed. Review manually.",
  },
  activity_unknown: {
    notifType: "SAFETY", severity: "INFO", sourceBuild: "LL",
    title: "Activity status unknown",
    cooldownMs: FIFTEEN_MINUTES,
    honestSuffix: "Alert only — auto-close is hard-blocked while activity is UNKNOWN.",
  },
  risk_limit_near: {
    notifType: "RISK", severity: "WARNING", sourceBuild: "LL",
    title: "Risk limit approaching",
    cooldownMs: FIVE_MINUTES,
    honestSuffix: "Alert only — no automatic action will be taken.",
  },
  risk_limit_breached: {
    notifType: "RISK", severity: "CRITICAL", sourceBuild: "LL",
    title: "Risk limit breached",
    cooldownMs: SIXTY_SECONDS,
    honestSuffix: "Alert only — review immediately. Live execution remains BLOCKED.",
  },
  trade_near_stop_loss: {
    notifType: "TRADE", severity: "WARNING", sourceBuild: "LL",
    title: "Trade near stop loss",
    cooldownMs: FIVE_MINUTES,
    honestSuffix: "Alert only — no trade was closed.",
  },
  trade_near_take_profit: {
    notifType: "TRADE", severity: "INFO", sourceBuild: "LL",
    title: "Trade near take profit",
    cooldownMs: FIVE_MINUTES,
    honestSuffix: "Alert only — no trade was closed.",
  },
  tp_targets_unavailable: {
    notifType: "DATA", severity: "INFO", sourceBuild: "LL",
    title: "Take-profit targets unavailable",
    cooldownMs: FIFTEEN_MINUTES,
    honestSuffix: "Alert only — TP distance could not be computed from live data.",
  },
  ai_close_warning: {
    notifType: "COACH", severity: "WARNING", sourceBuild: "LL",
    title: "AI close warning",
    cooldownMs: FIVE_MINUTES,
    honestSuffix: "AI alert only — review manually. No trade was closed.",
  },
  duplicate_action_blocked: {
    notifType: "SAFETY", severity: "INFO", sourceBuild: "LL",
    title: "Duplicate action blocked",
    cooldownMs: SIXTY_SECONDS,
    honestSuffix: "Alert only — the duplicate action was suppressed.",
  },
} as const);

/** Input accepted by `fireSafetyAlert`. All optional except `kind` + `message`. */
export interface SafetyAlertInput {
  kind: SafetyAlertKind;
  /** Free-form short reason from the caller; will be safety-suffixed. */
  message: string;
  /** Per-user scope. `null`/omit = system-wide (legacy notifications table). */
  userId?: number | null;
  /** Optional related identifiers so dedupe is per-target. */
  symbol?: string | null;
  relatedTradeId?: string | null;
  sourceEventId?: string | null;
  /** Optional metadata. Will be scrubbed for secrets by `notify()`. */
  metadata?: Record<string, unknown>;
  /** Optional override of cooldown window in ms. */
  cooldownMsOverride?: number;
}

function bucketStr(now: number, windowMs: number): string {
  return String(Math.floor(now / Math.max(1, windowMs)));
}

// Sanitize scope components so colons / whitespace in symbol or tradeId
// cannot smuggle a collision into the dedupe-key namespace.
function safeScope(s: string | null | undefined): string {
  if (s == null) return "_";
  const cleaned = String(s).replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.length === 0 ? "_" : cleaned.slice(0, 64);
}

// Clamp caller-supplied cooldown overrides to a sane range. Prevents both
// 0ms (every call new row) and >24h (silent suppression).
function clampCooldown(ms: number | undefined, fallback: number): number {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return fallback;
  const MIN = 1_000;            // 1s lower bound
  const MAX = 24 * 60 * 60_000; // 24h upper bound
  return Math.max(MIN, Math.min(MAX, Math.floor(ms)));
}

/**
 * Fire a canonical safety alert. All 18 kinds route through this function so
 * dedupe windows, honesty suffixes, and severity are uniform.
 *
 * Returns the underlying `notify()` result; never throws on rule-level issues —
 * the caller should treat this as fire-and-forget for safety telemetry.
 */
export async function fireSafetyAlert(input: SafetyAlertInput): Promise<NotifyResult> {
  const entry = CATALOG[input.kind];
  const safeUserScope = input.userId == null ? "sys" : `u${input.userId}`;
  if (!entry) {
    // Defensive: unknown kinds become a SYSTEM warning rather than throwing.
    // Dedupe key still includes user scope + 5min bucket so unknown-kind
    // events cannot collide across users or pile up unbounded.
    const unknownKind = safeScope(String(input.kind));
    const unknownBucket = bucketStr(Date.now(), FIVE_MINUTES);
    return notify({
      type: "SYSTEM", severity: "WARNING", sourceBuild: "LL",
      title: "Unknown safety alert kind",
      message: `Caller requested unknown alert kind: ${unknownKind}`,
      dedupeKey: `LL:UNKNOWN_KIND:${unknownKind}:${safeUserScope}:${unknownBucket}`,
      userId: input.userId ?? null,
    });
  }
  const windowMs = clampCooldown(input.cooldownMsOverride, entry.cooldownMs);
  const bucket = bucketStr(Date.now(), windowMs);
  const scope = [safeUserScope, safeScope(input.symbol), safeScope(input.relatedTradeId)].join(":");
  const dedupeKey = `LL:SAFETY_ALERT:${input.kind}:${scope}:${bucket}`;
  // The caller's free-form reason is clearly LABELED as "Reason:" so the
  // catalog-owned honest suffix cannot be visually confused with caller
  // text. Caller text is truncated to keep the audit line bounded.
  const reasonText = String(input.message ?? "").trim().slice(0, 280) || "(no reason supplied)";
  const composedMessage = entry.honestSuffix
    ? `Reason: ${reasonText} — ${entry.honestSuffix}`
    : `Reason: ${reasonText}`;
  const payload: NotifyInput & { userId?: number | null } = {
    type: entry.notifType,
    severity: entry.severity,
    title: entry.title,
    message: composedMessage,
    sourceBuild: entry.sourceBuild,
    sourceEventId: input.sourceEventId ?? null,
    symbol: input.symbol ?? null,
    relatedTradeId: input.relatedTradeId ?? null,
    actionRequired: entry.severity === "CRITICAL",
    metadata: {
      ...(input.metadata ?? {}),
      safetyAlertKind: input.kind,
      cooldownMs: windowMs,
      safetyEnvelope: {
        safetyMode: "paper_only",
        liveLocked: true,
        readOnlyMode: true,
        allowOrderExecution: false,
      },
    },
    dedupeKey,
    userId: input.userId ?? null,
  };
  return notify(payload, { idempotent: true });
}

/** Read-only export for tests / introspection. Returns a defensive shallow
 * copy of frozen entries so callers cannot mutate the live CATALOG even via
 * the returned reference. */
export function getSafetyAlertCatalog(): Readonly<Record<SafetyAlertKind, Readonly<CatalogEntry>>> {
  const out = {} as Record<SafetyAlertKind, Readonly<CatalogEntry>>;
  for (const k of Object.keys(CATALOG) as SafetyAlertKind[]) {
    out[k] = Object.freeze({ ...CATALOG[k] });
  }
  return Object.freeze(out);
}
