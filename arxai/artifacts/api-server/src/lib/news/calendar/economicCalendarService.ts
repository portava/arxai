// Central economic-calendar service — the SINGLE source of truth every consumer
// surface (Market Impact Radar, Global Market Heat, Eleanor, the Economic Calendar
// page DB-sync, /news/calendar) derives from.
//
// HONESTY (inviolable):
//   - No provider key            ⇒ status "missing"  ("Economic calendar provider missing")
//   - Provider configured, fetch fails ⇒ status "error" ("Economic calendar provider error")
//   - Provider reachable, zero events  ⇒ status "empty" ("No relevant economic events")
//   - Provider reachable, >0 events    ⇒ status "ok"
//   Stale cached events are returned ONLY on error and ONLY labelled freshness:"STALE"
//   (and connected:false, so live surfaces still suppress them). Nothing is fabricated.
//
// Read/risk-context only. Imports nothing from the execution path, MT5 bridge,
// broker dispatch, or any safety gate.

import { createHash } from "node:crypto";
import { logger } from "../../logger.js";
import type {
  CalendarEvent,
  EconomicCalendarDiagnostics,
  EconomicCalendarResult,
  EconomicCalendarStatus,
} from "./calendarTypes.js";
import {
  type CalendarHttpFetcher,
  TRADING_ECONOMICS_PROVIDER,
  fetchTradingEconomicsCalendar,
  redactError,
  resolveTradingEconomicsConfig,
  isTradingEconomicsSelected,
} from "./tradingEconomicsProvider.js";
import {
  FRED_PROVIDER,
  fetchFredCalendar,
  redactFredError,
  resolveFredConfig,
  isFredSelected,
} from "./fredCalendarProvider.js";

const CACHE_TTL_MS = 5 * 60_000; // 5 min — calendars change slowly.
const DELAYED_AFTER_MS = 2 * 60_000;
const DEFAULT_DAYS_AHEAD = 7;
const FETCH_TIMEOUT_MS = 8_000;

interface CacheEntry {
  events: CalendarEvent[];
  fetchedAtMs: number;
  /** Horizon this entry was fetched for — cache is only reused for the SAME window. */
  daysAhead: number;
  windowStart: string;
}

let _cache: CacheEntry | null = null;
// A cache belongs to a provider configuration, never merely to a horizon.
// Hashes are internal only; raw credentials never enter diagnostics or cache keys.
let _configurationKey: string | null = null;
let _generation = 0;
let _fetchSequence = 0;
interface PendingFetch { promise: Promise<CalendarEvent[]>; sequence: number; fetchedAtMs: number; superseded: boolean }
const _pending = new Map<string, PendingFetch>();
const configurationKey = (provider: string, config: unknown) =>
  createHash("sha256").update(JSON.stringify([provider, config])).digest("hex");
let _lastFetchAt: number | null = null;
let _lastSuccessAt: number | null = null;
let _lastError: string | null = null;
let _lastStatus: EconomicCalendarStatus = "missing";

// Injectable fetcher for tests. Defaults to global fetch.
let _fetcher: CalendarHttpFetcher | null = null;

/** TEST-ONLY: inject an HTTP fetcher (or null to restore global fetch). */
export function __setEconomicCalendarFetcherForTests(fn: CalendarHttpFetcher | null): void {
  _fetcher = fn;
}

/** Invalidate cached evidence, pending publication rights and telemetry. */
function resetCalendarState(): void {
  _cache = null;
  _configurationKey = null;
  _generation++;
  _fetchSequence = 0;
  _pending.clear();
  _lastFetchAt = null;
  _lastSuccessAt = null;
  _lastError = null;
  _lastStatus = "missing";
}

export function __resetEconomicCalendarStateForTests(): void { resetCalendarState(); }

function defaultFetcher(): CalendarHttpFetcher {
  return async (url: string) => {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return { ok: r.ok, status: r.status, text: () => r.text() };
  };
}

function freshnessForAge(ageMs: number): CalendarEvent["freshness"] {
  if (ageMs <= DELAYED_AFTER_MS) return "LIVE";
  if (ageMs <= CACHE_TTL_MS) return "DELAYED";
  return "STALE";
}

function messageFor(status: EconomicCalendarStatus, provider: string): string {
  switch (status) {
    case "missing":
      return "Economic calendar provider missing — no provider is configured.";
    case "error":
      return `Economic calendar provider error — ${provider} could not be reached.`;
    case "empty":
      return "No relevant economic events.";
    case "ok":
      return "Economic calendar connected.";
  }
}

function buildDiagnostics(args: {
  provider: string;
  configured: boolean;
  apiKeyPresent: boolean;
  status: EconomicCalendarStatus;
  events: CalendarEvent[];
  freshness: CalendarEvent["freshness"];
  cacheAgeMs: number | null;
}): EconomicCalendarDiagnostics {
  return {
    provider: args.provider,
    configured: args.configured,
    apiKeyPresent: args.apiKeyPresent,
    status: args.status,
    lastFetchAt: _lastFetchAt != null ? new Date(_lastFetchAt).toISOString() : null,
    lastSuccessAt: _lastSuccessAt != null ? new Date(_lastSuccessAt).toISOString() : null,
    lastError: _lastError,
    eventCount: args.events.length,
    freshness: args.freshness,
    cacheAgeMs: args.cacheAgeMs,
  };
}

/**
 * The resolved active provider — the ONE place provider choice is made. Trading
 * Economics takes precedence (back-compat), then FRED. The honesty state machine
 * in getEconomicCalendarResult is IDENTICAL regardless of which provider is
 * active; only the name / fetch / redact / key-presence differ here.
 */
interface ActiveCalendarProvider {
  name: string;
  configurationKey: string;
  apiKeyPresent: boolean;
  fetch(opts: { daysAhead: number; nowMs: number; fetcher: CalendarHttpFetcher }): Promise<CalendarEvent[]>;
  redact(err: unknown): string;
}

function resolveActiveCalendarProvider(): ActiveCalendarProvider | null {
  const teCfg = resolveTradingEconomicsConfig();
  if (teCfg) {
    return {
      name: TRADING_ECONOMICS_PROVIDER,
      configurationKey: configurationKey(TRADING_ECONOMICS_PROVIDER, teCfg),
      apiKeyPresent: (process.env["TRADING_ECONOMICS_KEY"] ?? "").trim().length > 0,
      fetch: (o) => fetchTradingEconomicsCalendar(teCfg, o),
      redact: (err) => redactError(err, teCfg),
    };
  }
  const fredCfg = resolveFredConfig();
  if (fredCfg) {
    return {
      name: FRED_PROVIDER,
      configurationKey: configurationKey(FRED_PROVIDER, fredCfg),
      apiKeyPresent: (process.env["FRED_API_KEY"] ?? "").trim().length > 0,
      fetch: (o) => fetchFredCalendar(fredCfg, o),
      redact: (err) => redactFredError(err, fredCfg),
    };
  }
  return null;
}

/**
 * The SELECTED provider's display label even when no key is present — used for
 * the honest "missing" diagnostics/provider field. Defaults to trading_economics
 * (the legacy default) when nothing is selected.
 */
function selectedProviderLabel(): string {
  if (isFredSelected()) return FRED_PROVIDER;
  return TRADING_ECONOMICS_PROVIDER;
}

/** Whether the SELECTED provider's API key is present (missing-branch diag). */
function selectedProviderApiKeyPresent(): boolean {
  const envKey = isFredSelected() ? "FRED_API_KEY" : "TRADING_ECONOMICS_KEY";
  return (process.env[envKey] ?? "").trim().length > 0;
}

export interface EconomicCalendarOptions {
  daysAhead?: number;
  nowMs?: number;
  /** Bypass the in-memory cache (force a fresh fetch). */
  forceRefresh?: boolean;
}

/**
 * Fetch the full normalized calendar with honest status. Never throws — all
 * failures degrade to status "error" with a redacted message.
 */
export async function getEconomicCalendarResult(
  opts: EconomicCalendarOptions = {},
): Promise<EconomicCalendarResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const daysAhead = opts.daysAhead ?? DEFAULT_DAYS_AHEAD;
  const active = resolveActiveCalendarProvider();
  if (_configurationKey !== (active?.configurationKey ?? null)) {
    resetCalendarState();
    _configurationKey = active?.configurationKey ?? null;
  }
  const generation = _generation;

  // ── Not configured ⇒ honest "missing" (never "no events"). ────────────────
  if (!active) {
    _lastStatus = "missing";
    const provider = selectedProviderLabel();
    const apiKeyPresent = selectedProviderApiKeyPresent();
    const diagnostics = buildDiagnostics({
      provider,
      configured: false,
      apiKeyPresent,
      status: "missing",
      events: [],
      freshness: "UNAVAILABLE",
      cacheAgeMs: null,
    });
    return {
      status: "missing",
      connected: false,
      configured: false,
      provider,
      events: [],
      diagnostics,
      message: messageFor("missing", provider),
    };
  }

  const provider = active.name;
  const apiKeyPresent = active.apiKeyPresent;
  const requestDate = new Date(nowMs);
  const windowStart = Number.isFinite(requestDate.getTime()) ? requestDate.toISOString().slice(0, 10) : "invalid";

  // ── Serve from cache when fresh AND for the SAME horizon. ─────────────────
  // The cache is keyed by daysAhead so a request for one window can never reuse
  // events fetched for a different window (e.g. days=14 reusing a days=7 entry).
  if (
    !opts.forceRefresh &&
    _cache &&
    _cache.daysAhead === daysAhead &&
    _cache.windowStart === windowStart &&
    nowMs >= _cache.fetchedAtMs &&
    nowMs - _cache.fetchedAtMs <= CACHE_TTL_MS
  ) {
    const ageMs = nowMs - _cache.fetchedAtMs;
    const freshness = freshnessForAge(ageMs);
    const events = _cache.events.map((e) => ({ ...e, freshness }));
    const status: EconomicCalendarStatus = events.length > 0 ? "ok" : "empty";
    _lastStatus = status;
    return {
      status,
      connected: true,
      configured: true,
      provider,
      events,
      diagnostics: buildDiagnostics({
        provider,
        configured: true,
        apiKeyPresent,
        status,
        events,
        freshness,
        cacheAgeMs: ageMs,
      }),
      message: messageFor(status, provider),
    };
  }

  // ── Fresh fetch. ──────────────────────────────────────────────────────────
  const fetcher = _fetcher ?? defaultFetcher();
  const requestKey = JSON.stringify([generation, windowStart, daysAhead]);
  let pending = !opts.forceRefresh ? _pending.get(requestKey) : undefined;
  // Never let a hung request (including an injected transport) permanently own
  // the single-flight slot, or treat a future-stamped request as fresh.
  if (pending && (nowMs < pending.fetchedAtMs || nowMs - pending.fetchedAtMs >= FETCH_TIMEOUT_MS)) pending = undefined;
  if (!pending) {
    const sequence = ++_fetchSequence;
    const previous = _pending.get(requestKey);
    if (previous) previous.superseded = true;
    pending = { promise: active.fetch({ daysAhead, nowMs, fetcher }), sequence, fetchedAtMs: nowMs, superseded: false };
    _pending.set(requestKey, pending);
    _lastFetchAt = Number.isFinite(requestDate.getTime()) ? nowMs : null;
  }
  const { sequence: fetchSequence, fetchedAtMs } = pending;
  try {
    const events = await pending.promise;
    // A newer fetch for this exact window supersedes old evidence. Distinct
    // windows remain independently valid, but only the latest request publishes
    // shared cache/diagnostics so an older completion cannot overwrite them.
    if (generation !== _generation || pending.superseded || active.configurationKey !== resolveActiveCalendarProvider()?.configurationKey) throw new Error("Calendar request superseded");
    const status: EconomicCalendarStatus = events.length > 0 ? "ok" : "empty";
    if (fetchSequence === _fetchSequence) {
      _cache = { events, fetchedAtMs, daysAhead, windowStart };
      _lastSuccessAt = fetchedAtMs;
      _lastError = null;
      _lastStatus = status;
    }
    return {
      status,
      connected: true,
      configured: true,
      provider,
      events,
      diagnostics: {
        ...buildDiagnostics({ provider, configured: true, apiKeyPresent, status, events,
          freshness: "LIVE", cacheAgeMs: 0 }),
        lastFetchAt: new Date(fetchedAtMs).toISOString(),
        lastSuccessAt: new Date(fetchedAtMs).toISOString(),
        lastError: null,
      },
      message: messageFor(status, provider),
    };
  } catch (err) {
    const error = active.redact(err);
    const current = generation === _generation && !pending.superseded && fetchSequence === _fetchSequence && active.configurationKey === resolveActiveCalendarProvider()?.configurationKey;
    if (current) {
      _lastError = error;
      _lastStatus = "error";
    }
    // Log presence only — NEVER the key/secret.
    logger.warn(
      { provider, configured: true, error },
      "economic calendar fetch failed",
    );
    // Stale cache is returned ONLY for diagnostics, labelled STALE + disconnected.
    const staleCache = current && _cache?.daysAhead === daysAhead && _cache.windowStart === windowStart
      && nowMs >= _cache.fetchedAtMs ? _cache : null;
    const staleEvents = staleCache?.events.map((e) => ({ ...e, freshness: "STALE" as const })) ?? [];
    return {
      status: "error",
      connected: false,
      configured: true,
      provider,
      events: staleEvents,
      diagnostics: {
        ...buildDiagnostics({
          provider, configured: true, apiKeyPresent, status: "error", events: staleEvents,
          freshness: staleEvents.length > 0 ? "STALE" : "UNAVAILABLE",
          cacheAgeMs: staleCache != null ? nowMs - staleCache.fetchedAtMs : null,
        }),
        ...(!current ? { lastFetchAt: Number.isFinite(requestDate.getTime()) ? requestDate.toISOString() : null, lastSuccessAt: null } : {}),
        lastError: error,
      },
      message: messageFor("error", provider),
    };
  } finally {
    if (_pending.get(requestKey) === pending) _pending.delete(requestKey);
  }
}

/** Operator diagnostics snapshot (never exposes the key). */
export async function getEconomicCalendarDiagnostics(): Promise<EconomicCalendarDiagnostics> {
  const result = await getEconomicCalendarResult();
  return result.diagnostics;
}

/** Whether a real calendar provider is configured with a key (presence only). */
export function isEconomicCalendarConfigured(): boolean {
  return resolveActiveCalendarProvider() !== null;
}

/**
 * The SELECTED provider name (regardless of key presence), or null when none is
 * selected. Trading Economics is checked first (back-compat), then FRED.
 */
export function selectedEconomicCalendarProvider(): string | null {
  if (isTradingEconomicsSelected()) return TRADING_ECONOMICS_PROVIDER;
  if (isFredSelected()) return FRED_PROVIDER;
  return null;
}

/**
 * Whether a real provider is SELECTED, regardless of key presence. Seams use
 * this (not isEconomicCalendarConfigured) to gate the mock back-compat path:
 * when a provider is selected but unconfigured/erroring, serve honest-empty —
 * never fabricated mock events. Mock applies ONLY when no provider is selected
 * (true legacy default).
 */
export function isEconomicCalendarProviderSelected(): boolean {
  return selectedEconomicCalendarProvider() !== null;
}
