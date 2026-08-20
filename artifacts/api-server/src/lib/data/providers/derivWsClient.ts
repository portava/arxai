// Deriv WebSocket client — lazy singleton.
//
// Connects to wss://ws.derivws.com/websockets/v3?app_id=<APP_ID> only
// when DERIV_APP_ID is set. Supports:
//   - request/response by req_id correlation (ticks_history, candles)
//   - tick subscription with REAL forget on unsubscribe (unsubscribeTicks →
//     `forget` by retained subscription id; forgetAllTicks → `forget_all`)
//   - account-identity retention from the authorize response (loginid,
//     is_virtual, currency, landing company) — see getAccountIdentity()
//   - ping keepalive every 30s
//   - exponential reconnect backoff (1s → 30s)
//   - bounded last-tick cache per symbol
//
// SAFETY:
//   - Never logs DERIV_APP_ID or DERIV_API_TOKEN values.
//   - On config absence, every public method returns a not-configured
//     envelope without attempting connection.
//   - Never fabricates candles. If the WS round-trip fails or times
//     out, returns { ok:false, reason }.

import WebSocket, { type RawData } from "ws";
// Type-only: the canonical DerivAccountIdentity lives in the pure domain layer
// (lib/domain/src/deriv-contracts) so the virtual execution gate and this
// retention site can never drift apart. Erased at runtime — no module graph.
import type { derivContracts } from "@workspace/domain";

import { logger } from "../../logger.js";
// NOTE: circular with derivProvider.ts (which imports this module). Safe only
// because BOTH sides dereference the other exclusively inside function bodies,
// never at module-init time — keep it that way.
import { DERIV_SYNTHETIC_SYMBOLS } from "./derivProvider.js";
import {
  parseActiveSymbols,
  validateKnownMap,
  type DerivDiscoverySnapshot,
  type DerivMapValidation,
} from "./derivSymbolDiscovery.js";

const DEFAULT_WS_URL = "wss://ws.derivws.com/websockets/v3";
const PING_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;

export type DerivGranularity = 60 | 120 | 180 | 300 | 600 | 900 | 1800 | 3600 | 7200 | 14400 | 28800 | 86400;

export interface DerivCandle {
  epoch: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface DerivTick {
  symbol: string;
  epoch: number;
  quote: number;
}

/** Observer notified for every live tick that lands on the socket. */
export type DerivTickListener = (tick: DerivTick) => void;

/** Canonical identity shape — single-sourced from the domain layer. */
export type DerivAccountIdentity = derivContracts.DerivAccountIdentity;

/** Outcome envelope for venue-side stream release. `forgot` is true ONLY when
 *  the venue confirmed the forget — local bookkeeping removal alone never
 *  claims it (honesty: a stream the venue may still push is not "forgotten"). */
export interface DerivForgetResult {
  ok: boolean;
  forgot: boolean;
  reason?: string;
}

interface PendingRequest {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class DerivWsClient {
  private ws: WebSocket | null = null;
  private connecting = false;
  private connected = false;
  private appId = "";
  private wsUrl = DEFAULT_WS_URL;
  private nextReqId = 1;
  private pending = new Map<number, PendingRequest>();
  private lastTickBySymbol = new Map<string, DerivTick>();
  // Observers notified per accepted tick. Used by the forming-bar bridge so a
  // Deriv-fed chart's tip advances on real ticks exactly like a broker-fed one.
  // Best-effort and advisory: a throwing listener never breaks tick handling.
  private tickListeners = new Set<DerivTickListener>();
  private subscribedSymbols = new Set<string>();
  private subscriptionIdBySymbol = new Map<string, string>();
  private reconnectCount = 0;
  private backoffMs = INITIAL_BACKOFF_MS;
  private lastErrorMessage: string | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastTickAt: number | null = null;
  private connectedAt: number | null = null;
  private authorized = false;
  private lastAuthorizeError: string | null = null;
  // Eager warm-up state — survives reconnects.
  private eagerWarmupSymbols = new Set<string>();
  private warmupAttemptedAt: number | null = null;
  private warmupCompletedAt: number | null = null;
  private activeSymbolsCount: number | null = null;
  private activeSymbolsLoadedAt: number | null = null;
  private activeSymbolsError: string | null = null;
  private lastCandleAt: number | null = null;
  // Runtime discovery retention (audit G1): the parsed active_symbols payload
  // itself, not just a count. Survives reconnects — staleness is judged by the
  // caller via the snapshot timestamp, never by nulling the last-known view.
  private lastDiscovery: DerivDiscoverySnapshot | null = null;
  private lastDiscoveryValidation: DerivMapValidation | null = null;
  // Warn-dedupe: mismatch warnings fire at most once per connect session.
  private discoveryMismatchWarnedThisConnect = false;
  // Account identity retained from THIS session's authorize response (audit
  // G2). Null until authorize succeeds and parses; cleared on connect/close so
  // the demo-only virtual gate never acts on a previous session's evidence.
  private accountIdentity: DerivAccountIdentity | null = null;
  // Warn-dedupe: the real-account warning fires at most once per connect.
  private realAccountWarnedThisConnect = false;

  configured(): boolean {
    const id = (process.env.DERIV_APP_ID ?? "").trim();
    return id.length > 0;
  }

  isConnected(): boolean { return this.connected; }
  getReconnectCount(): number { return this.reconnectCount; }
  getLastErrorMessage(): string | null { return this.lastErrorMessage; }
  getSubscribedSymbols(): string[] { return [...this.subscribedSymbols]; }
  getLastTickAt(): string | null { return this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null; }
  getLastTickAgeMs(): number | null { return this.lastTickAt ? Date.now() - this.lastTickAt : null; }
  getConnectedAt(): string | null { return this.connectedAt ? new Date(this.connectedAt).toISOString() : null; }
  getEagerWarmupSymbols(): string[] { return [...this.eagerWarmupSymbols]; }
  getWarmupAttemptedAt(): string | null { return this.warmupAttemptedAt ? new Date(this.warmupAttemptedAt).toISOString() : null; }
  getWarmupCompletedAt(): string | null { return this.warmupCompletedAt ? new Date(this.warmupCompletedAt).toISOString() : null; }
  getActiveSymbolsCount(): number | null { return this.activeSymbolsCount; }
  getActiveSymbolsLoadedAt(): string | null { return this.activeSymbolsLoadedAt ? new Date(this.activeSymbolsLoadedAt).toISOString() : null; }
  getActiveSymbolsError(): string | null { return this.activeSymbolsError; }
  getLastCandleAt(): string | null { return this.lastCandleAt ? new Date(this.lastCandleAt).toISOString() : null; }
  /** Last retained active_symbols discovery (timestamped), or null when no
   *  discovery has completed since process start. */
  getLastDiscovery(): DerivDiscoverySnapshot | null { return this.lastDiscovery; }
  getLastDiscoveryAgeMs(): number | null {
    return this.lastDiscovery ? Date.now() - this.lastDiscovery.fetchedAtMs : null;
  }
  /** Report-only static-map validation from the last NON-EMPTY discovery.
   *  Null when discovery has not run or returned an empty payload (an empty
   *  payload is not evidence the venue lacks our ids). */
  getLastDiscoveryValidation(): DerivMapValidation | null { return this.lastDiscoveryValidation; }
  /** Account identity retained from THIS session's authorize, or null when no
   *  authorize has succeeded this session. Null must be treated as UNKNOWN by
   *  every consumer — the demo-only virtual gate refuses it. */
  getAccountIdentity(): DerivAccountIdentity | null { return this.accountIdentity; }
  /** Returns true when active_symbols has been fetched at least once
   *  since the most recent successful connect/authorize. */
  isActiveSymbolsLoaded(): boolean { return this.activeSymbolsCount != null; }
  /** Returns true when at least one live tick has landed in the cache
   *  within the freshness window (default 30s). */
  hasRecentTick(maxAgeMs: number = 30_000): boolean {
    const age = this.getLastTickAgeMs();
    return age != null && age <= maxAgeMs;
  }
  /** Cached tick lookup by Deriv id (no subscribe). */
  getCachedTickByDerivId(derivId: string): DerivTick | null { return this.lastTickBySymbol.get(derivId) ?? null; }

  /** Subscribe to every accepted live tick. Returns an unsubscribe function. */
  onTick(listener: DerivTickListener): () => void {
    this.tickListeners.add(listener);
    return () => { this.tickListeners.delete(listener); };
  }

  /** Notify observers. Advisory only — a throwing listener is swallowed so it
   *  can never break tick caching or the socket read loop. */
  private emitTick(tick: DerivTick): void {
    for (const listener of this.tickListeners) {
      try {
        listener(tick);
      } catch {
        // Ignore — display/telemetry observers must not affect the feed.
      }
    }
  }

  /** Detect which API mode to use based on env vars. */
  static detectMode(): "new" | "legacy" | "none" {
    const mode = (process.env.DERIV_API_MODE ?? "auto").trim().toLowerCase();
    const appId = (process.env.DERIV_APP_ID ?? "").trim();
    const token = (process.env.DERIV_API_TOKEN ?? "").trim();
    if (mode === "legacy") return "legacy";
    if (mode === "new") return "new";
    // auto: alphanumeric appId + PAT token → new mode
    if (appId && token && /[a-zA-Z]/.test(appId)) return "new";
    // auto: numeric appId → legacy
    if (appId && /^\d+$/.test(appId)) return "legacy";
    return "none";
  }

  /** Idempotent: ensures the WS is connected or in-flight. */
  ensureConnection(): void {
    if (!this.configured()) return;
    if (this.connected || this.connecting) return;
    this.connecting = true;
    this.appId = (process.env.DERIV_APP_ID ?? "").trim();
    // Determine connection URL based on mode
    void this.resolveWsUrl().then(url => {
      if (!url) {
        this.connecting = false;
        this.lastErrorMessage = "deriv_config: Could not resolve WebSocket URL. Check DERIV_APP_ID, DERIV_API_TOKEN, and DERIV_API_MODE.";
        return;
      }
      this.wsUrl = url;
      try {
        const ws = new WebSocket(url, { handshakeTimeout: 5_000 });
        this.ws = ws;
        ws.on("open", () => {
          this.connected = true;
          this.connecting = false;
          this.connectedAt = Date.now();
          this.backoffMs = INITIAL_BACKOFF_MS;
          this.lastErrorMessage = null;
          this.authorized = false;
          this.lastAuthorizeError = null;
          // Reset per-session caches; a fresh authorize may give a different view.
          this.activeSymbolsCount = null;
          this.activeSymbolsLoadedAt = null;
          this.activeSymbolsError = null;
          // New connect session — mismatch warnings may fire once again.
          this.discoveryMismatchWarnedThisConnect = false;
          // Identity is per-session evidence: a reconnect must re-prove it via
          // a fresh authorize (fail-closed — the virtual gate refuses null).
          this.accountIdentity = null;
          this.realAccountWarnedThisConnect = false;
          this.startPing();
          // If a token is configured (either mode), authorize and track the response.
          const token = (process.env.DERIV_API_TOKEN ?? "").trim();
          if (token) {
            this.request({ authorize: token }).then((resp) => {
              if (resp.authorize) {
                this.authorized = true;
                this.lastAuthorizeError = null;
                // Retain the payload instead of discarding it (audit G2):
                // loginid / is_virtual / currency / landing company, plus the
                // DERIV_ENVIRONMENT assertion. Never logs or stores the token.
                this.retainAccountIdentity(resp.authorize);
              }
              // Kick off eager warm-up regardless of authorize outcome:
              // active_symbols + ticks_history work for both authed and
              // unauthed (public) connections on Deriv synthetic indices.
              void this.runEagerWarmup();
            }).catch((err: Error) => {
              this.authorized = false;
              this.lastAuthorizeError = err.message.slice(0, 200);
              // Still attempt warm-up — public synthetics don't require auth.
              void this.runEagerWarmup();
            });
          } else {
            // No token — warm up immediately on the public app_id connection.
            void this.runEagerWarmup();
          }
        });
        ws.on("message", (data: RawData) => this.handleMessage(data));
        ws.on("close", () => this.handleClose());
        ws.on("error", (err) => {
          // Never include credentials/url in the error message.
          this.lastErrorMessage = `ws_error: ${err.message}`.replace(this.appId, "<redacted>");
        });
      } catch (err) {
        this.connecting = false;
        this.lastErrorMessage = `connect_throw: ${(err as Error).message}`.replace(this.appId, "<redacted>");
        this.scheduleReconnect();
      }
    }).catch(err => {
      this.connecting = false;
      this.lastErrorMessage = `otp_error: ${(err as Error).message.slice(0, 100)}`;
      this.scheduleReconnect();
    });
  }

  /** Resolves the WebSocket URL. Both modes use the same WS endpoint; only
   *  the app_id source differs. PAT auth happens via the `authorize` request
   *  after the socket is open (tracked) so admins see real Deriv errors. */
  private async resolveWsUrl(): Promise<string | null> {
    const mode = DerivWsClient.detectMode();
    const base = (process.env.DERIV_WS_URL ?? "").trim() || DEFAULT_WS_URL;
    if (mode === "new") {
      // Alphanumeric DERIV_APP_ID is a Deriv Developers/PAT app id and cannot
      // be passed to the legacy WS handshake. Use the public bootstrap app id
      // (overridable via DERIV_WS_LEGACY_APP_ID) and authorize with the PAT.
      const bootstrap = (process.env.DERIV_WS_LEGACY_APP_ID ?? "1089").trim();
      return `${base}?app_id=${encodeURIComponent(bootstrap)}`;
    }
    if (mode === "legacy") {
      const legacyId = (process.env.DERIV_WS_LEGACY_APP_ID ?? this.appId).trim();
      return `${base}?app_id=${encodeURIComponent(legacyId)}`;
    }
    return null;
  }

  /** Returns current mode for diagnostics. Never returns raw secrets. */
  getMode(): "new" | "legacy" | "none" {
    return DerivWsClient.detectMode();
  }

  isAuthorized(): boolean { return this.authorized; }
  getLastAuthorizeError(): string | null { return this.lastAuthorizeError; }

  /** Active probe: runs `active_symbols` + `ticks_history(R_75, 60s, 5)`
   *  through the WS and returns sanitized results. Admin-only callers. */
  async probe(): Promise<{
    connected: boolean;
    authorized: boolean;
    activeSymbolsCount: number | null;
    activeSymbolsError: string | null;
    ticksHistoryCount: number | null;
    lastCandleEpoch: number | null;
    ticksHistoryError: string | null;
  }> {
    if (!this.configured()) {
      return { connected: false, authorized: false, activeSymbolsCount: null,
        activeSymbolsError: "DERIV_NOT_CONFIGURED", ticksHistoryCount: null,
        lastCandleEpoch: null, ticksHistoryError: "DERIV_NOT_CONFIGURED" };
    }
    this.ensureConnection();
    // Give the WS a moment to open if we just kicked it off.
    if (!this.connected) await new Promise(r => setTimeout(r, 1500));

    let activeSymbolsCount: number | null = null;
    let activeSymbolsError: string | null = null;
    try {
      const resp = await this.request({ active_symbols: "brief", product_type: "basic" });
      const arr = resp.active_symbols as unknown[] | undefined;
      activeSymbolsCount = Array.isArray(arr) ? arr.length : 0;
      this.retainDiscovery(arr);
    } catch (err) {
      activeSymbolsError = (err as Error).message.slice(0, 200);
    }

    let ticksHistoryCount: number | null = null;
    let lastCandleEpoch: number | null = null;
    let ticksHistoryError: string | null = null;
    try {
      const candles = await this.getCandles("R_75", 60, 5);
      ticksHistoryCount = candles.length;
      lastCandleEpoch = candles.length > 0 ? candles[candles.length - 1].epoch : null;
    } catch (err) {
      ticksHistoryError = (err as Error).message.slice(0, 200);
    }

    return {
      connected: this.connected,
      authorized: this.authorized,
      activeSymbolsCount,
      activeSymbolsError,
      ticksHistoryCount,
      lastCandleEpoch,
      ticksHistoryError,
    };
  }

  getMaskedAppId(): string {
    const id = (process.env.DERIV_APP_ID ?? "").trim();
    if (!id) return "not set";
    if (id.length <= 4) return "****";
    return id.slice(0, 2) + "****" + id.slice(-2);
  }

  getMaskedToken(): string {
    const t = (process.env.DERIV_API_TOKEN ?? "").trim();
    if (!t) return "not set";
    return t.slice(0, 4) + "****";
  }

  getAccountIdConfigured(): boolean {
    return !!(process.env.DERIV_ACCOUNT_ID ?? "").trim();
  }

  getOtpLastResult(): string | null {
    // Legacy diagnostic field. The OTP endpoint was removed (it was invented
    // and producing misleading errors). Return the authorize error instead,
    // which is the real failure surface for PAT auth.
    return this.lastAuthorizeError ?? this.lastErrorMessage;
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.connected || !this.ws) return;
      // Deriv expects ping as a JSON `ping` request, not a WS-frame ping.
      this.sendRaw({ ping: 1 });
    }, PING_MS);
  }

  private handleClose(): void {
    this.connected = false;
    this.connecting = false;
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("ws_closed"));
    }
    this.pending.clear();
    this.subscribedSymbols.clear();
    this.subscriptionIdBySymbol.clear();
    // Identity describes a live authorized session; a dead socket is not one.
    // The reconnect's fresh authorize re-proves it (fail-closed in between).
    this.accountIdentity = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.configured()) return;
    if (this.reconnectTimer) return;
    this.reconnectCount += 1;
    const wait = Math.min(this.backoffMs, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      this.ensureConnection();
    }, wait);
  }

  private sendRaw(payload: Record<string, unknown>): void {
    if (!this.ws || !this.connected) return;
    try { this.ws.send(JSON.stringify(payload)); } catch { /* ignore */ }
  }

  /** Send a request with req_id correlation. Rejects on timeout/close. */
  private request<T extends Record<string, unknown>>(payload: Omit<T, "req_id">): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.configured()) {
        reject(new Error("deriv_not_configured")); return;
      }
      this.ensureConnection();
      if (!this.connected || !this.ws) {
        reject(new Error("ws_not_connected")); return;
      }
      const reqId = this.nextReqId++;
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("request_timeout"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve, reject, timer });
      this.sendRaw({ ...(payload as object), req_id: reqId });
    });
  }

  private handleMessage(data: RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof data === "string" ? data : data.toString()) as Record<string, unknown>;
    } catch { return; }

    // Subscription stream (tick).
    const tick = msg.tick as Record<string, unknown> | undefined;
    if (tick && typeof tick.symbol === "string" && typeof tick.quote === "number" && typeof tick.epoch === "number") {
      const sym = tick.symbol as string;
      const accepted: DerivTick = { symbol: sym, epoch: tick.epoch as number, quote: tick.quote as number };
      this.lastTickBySymbol.set(sym, accepted);
      this.lastTickAt = Date.now();
      const subId = (msg.subscription as Record<string, unknown> | undefined)?.id;
      if (typeof subId === "string") this.subscriptionIdBySymbol.set(sym, subId);
      this.emitTick(accepted);
    }

    // Correlated response.
    const reqId = msg.req_id;
    if (typeof reqId === "number" && this.pending.has(reqId)) {
      const p = this.pending.get(reqId)!;
      clearTimeout(p.timer);
      this.pending.delete(reqId);
      if (msg.error) {
        const err = msg.error as Record<string, unknown>;
        p.reject(new Error(typeof err.message === "string" ? err.message : "deriv_error"));
      } else {
        p.resolve(msg);
      }
    }
  }

  /** Fetch historical candles for a Deriv symbol.
   *  `endEpochSeconds` (optional) anchors the request to a point in the PAST so
   *  older history can be paged in (Deriv returns `count` candles ENDING at
   *  `end`). When omitted, `end:"latest"` returns the most recent window
   *  (unchanged default behavior). */
  async getCandles(
    derivSymbol: string,
    granularity: DerivGranularity,
    count: number,
    endEpochSeconds?: number,
  ): Promise<DerivCandle[]> {
    const end =
      endEpochSeconds != null && Number.isFinite(endEpochSeconds) && endEpochSeconds > 0
        ? Math.floor(endEpochSeconds)
        : "latest";
    const resp = await this.request({
      ticks_history: derivSymbol,
      adjust_start_time: 1,
      count: Math.max(1, Math.min(5000, count)),
      end,
      style: "candles",
      granularity,
    });
    const arr = resp.candles as Array<{ epoch: number; open: number; high: number; low: number; close: number }> | undefined;
    if (!Array.isArray(arr)) return [];
    const out = arr.map((c) => ({ epoch: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close }));
    if (out.length > 0) this.lastCandleAt = Date.now();
    return out;
  }

  /** Retain the parsed `active_symbols` payload (timestamped) and validate
   *  the static synthetic map against it. Report-only (honesty doctrine):
   *  mismatches are logged and surfaced for operators — NEVER auto-corrected,
   *  because a guessed venue id must fail loudly rather than be silently
   *  rewritten to whatever looks closest. Does not change which symbols
   *  subscribe or any execution surface. */
  private retainDiscovery(rawActiveSymbols: unknown): void {
    const now = Date.now();
    const symbols = parseActiveSymbols(rawActiveSymbols);
    this.lastDiscovery = {
      fetchedAt: new Date(now).toISOString(),
      fetchedAtMs: now,
      symbols,
    };
    if (symbols.length === 0) {
      // An empty/unparseable payload is not evidence the venue lacks our ids —
      // skip validation instead of reporting every static symbol as missing.
      this.lastDiscoveryValidation = null;
      return;
    }
    const validation = validateKnownMap(symbols, DERIV_SYNTHETIC_SYMBOLS);
    this.lastDiscoveryValidation = validation;
    if (this.discoveryMismatchWarnedThisConnect) return;
    if (validation.missingFromVenue.length === 0 && validation.unknownAtVenue.length === 0) return;
    this.discoveryMismatchWarnedThisConnect = true;
    for (const miss of validation.missingFromVenue) {
      logger.warn(
        { arxSymbol: miss.arxSymbol, derivId: miss.derivId, displayName: miss.displayName },
        "Deriv discovery mismatch: static-map id not reported by active_symbols (report-only; id NOT auto-corrected)",
      );
    }
    if (validation.unknownAtVenue.length > 0) {
      logger.warn(
        { count: validation.unknownAtVenue.length, derivIds: validation.unknownAtVenue },
        "Deriv discovery: venue synthetic-index ids absent from the static map (report-only)",
      );
    }
  }

  /** Retain the parsed `authorize` payload as this session's account identity
   *  (audit G2: previously discarded — only a boolean survived).
   *
   *  HONESTY RULES:
   *    - Absent fields stay null; is_virtual missing reads UNKNOWN (null),
   *      never demo. The virtual gate refuses null.
   *    - DERIV_ENVIRONMENT is wired as an ASSERTION, not a selector: when the
   *      operator declared "demo" but the venue reports a REAL account,
   *      identityMismatch is marked and warned — never silently reconciled.
   *    - DERIV_ACCOUNT_ID remains presence-only (it selects nothing); account
   *      selection is out of scope for this slice.
   *    - NEVER logs the token; only identity fields appear in log payloads.
   *    - Warns at most ONCE per connect session when the account is REAL. */
  private retainAccountIdentity(rawAuthorize: unknown): void {
    const now = Date.now();
    const rec = (typeof rawAuthorize === "object" && rawAuthorize !== null)
      ? rawAuthorize as Record<string, unknown>
      : {};
    const loginid = typeof rec.loginid === "string" && rec.loginid.length > 0 ? rec.loginid : null;
    const isVirtual =
      rec.is_virtual === 1 || rec.is_virtual === true ? true
      : rec.is_virtual === 0 || rec.is_virtual === false ? false
      : null;
    const currency = typeof rec.currency === "string" && rec.currency.length > 0 ? rec.currency : null;
    const landingCompany =
      typeof rec.landing_company_name === "string" && rec.landing_company_name.length > 0
        ? rec.landing_company_name
        : typeof rec.landing_company_fullname === "string" && rec.landing_company_fullname.length > 0
          ? rec.landing_company_fullname
          : null;
    const declaredRaw = (process.env.DERIV_ENVIRONMENT ?? "").trim().toLowerCase();
    const declaredEnvironment = declaredRaw.length > 0 ? declaredRaw : null;
    const identityMismatch = declaredEnvironment === "demo" && isVirtual === false;
    this.accountIdentity = {
      loginid,
      isVirtual,
      currency,
      landingCompany,
      declaredEnvironment,
      identityMismatch,
      retainedAt: new Date(now).toISOString(),
      retainedAtMs: now,
    };
    if (isVirtual === false && !this.realAccountWarnedThisConnect) {
      this.realAccountWarnedThisConnect = true;
      logger.warn(
        { loginid, currency, landingCompany, declaredEnvironment },
        "Deriv connection is a REAL account — execution slices are demo-only and will refuse",
      );
      if (identityMismatch) {
        logger.warn(
          { loginid, declaredEnvironment },
          "DERIV_ENVIRONMENT=demo contradicts the venue-reported REAL account — identityMismatch marked; resolve the config or the token",
        );
      }
    }
  }

  /** Eager warm-up: runs once per successful WS session. Fetches
   *  active_symbols (cached count for diagnostics) and subscribes to a
   *  small set of core synthetic-index tick streams so the in-memory
   *  last-tick cache is populated within seconds of server boot.
   *  Re-runs on every reconnect. Errors are captured but never thrown. */
  private async runEagerWarmup(): Promise<void> {
    if (!this.connected) return;
    this.warmupAttemptedAt = Date.now();
    // 1) active_symbols (brief, basic product) — cache count for diagnostics
    //    and retain the parsed payload for runtime-discovery validation.
    try {
      const resp = await this.request({ active_symbols: "brief", product_type: "basic" });
      const arr = resp.active_symbols as unknown[] | undefined;
      this.activeSymbolsCount = Array.isArray(arr) ? arr.length : 0;
      this.activeSymbolsLoadedAt = Date.now();
      this.activeSymbolsError = null;
      this.retainDiscovery(arr);
    } catch (err) {
      this.activeSymbolsError = (err as Error).message.slice(0, 200);
    }
    // 2) Eager tick subscription for the core synthetic symbols users
    //    most commonly watch. Resubscribes after every reconnect (the
    //    handleClose path clears subscribedSymbols but never clears
    //    eagerWarmupSymbols, so this set is the persistent source of
    //    truth for what we want subscribed at all times).
    const defaults = ["R_25", "R_75", "1HZ25V", "1HZ75V", "BOOM1000", "CRASH1000"];
    for (const d of defaults) this.eagerWarmupSymbols.add(d);
    for (const derivId of this.eagerWarmupSymbols) {
      try { await this.subscribeTicks(derivId); } catch { /* ignore single-symbol failure */ }
    }
    this.warmupCompletedAt = Date.now();
  }

  /** Subscribe to live ticks for a symbol. */
  async subscribeTicks(derivSymbol: string): Promise<DerivTick | null> {
    if (this.subscribedSymbols.has(derivSymbol)) {
      return this.lastTickBySymbol.get(derivSymbol) ?? null;
    }
    let resp: Record<string, unknown>;
    try {
      resp = await this.request({ ticks: derivSymbol, subscribe: 1 });
    } catch (err) {
      // Deriv answering "already subscribed" means the stream IS active —
      // record it locally so the keep-alive stops re-attempting (and warning)
      // every cycle. Log-hygiene only; no connection/behavior change.
      if (/already subscribed/i.test((err as Error).message)) {
        this.subscribedSymbols.add(derivSymbol);
        this.eagerWarmupSymbols.add(derivSymbol);
        return this.lastTickBySymbol.get(derivSymbol) ?? null;
      }
      throw err;
    }
    this.subscribedSymbols.add(derivSymbol);
    // Track as eager so reconnects re-subscribe automatically.
    this.eagerWarmupSymbols.add(derivSymbol);
    // Retain the subscription id from the subscribe RESPONSE itself (the
    // stream-message path also captures it, but the response is the earliest
    // and most reliable source) — required for a targeted `forget` later.
    const subscription = resp.subscription as { id?: unknown } | undefined;
    if (subscription && typeof subscription.id === "string" && subscription.id.length > 0) {
      this.subscriptionIdBySymbol.set(derivSymbol, subscription.id);
    }
    const tick = resp.tick as { symbol?: string; epoch?: number; quote?: number } | undefined;
    if (tick && typeof tick.epoch === "number" && typeof tick.quote === "number") {
      const t: DerivTick = { symbol: derivSymbol, epoch: tick.epoch, quote: tick.quote };
      this.lastTickBySymbol.set(derivSymbol, t);
      this.lastTickAt = Date.now();
      return t;
    }
    return null;
  }

  getCachedTick(derivSymbol: string): DerivTick | null {
    return this.lastTickBySymbol.get(derivSymbol) ?? null;
  }

  /** Release ONE tick stream (audit G11 — the header claimed forget-on-
   *  unsubscribe for years while no `forget` existed anywhere).
   *
   *  Local bookkeeping (subscribedSymbols / eagerWarmupSymbols /
   *  subscriptionIdBySymbol) is removed FIRST and unconditionally so a
   *  reconnect can never resurrect a stream the caller dropped, even when the
   *  venue-side forget fails. The result is honest about what happened:
   *  `forgot` is true ONLY on venue confirmation — a locally-dropped stream
   *  the venue may still push until socket death is reported as such, never
   *  claimed forgotten. The last-tick cache is intentionally kept: it is
   *  historical truth with its own age gating (per-symbol feed honesty). */
  async unsubscribeTicks(derivSymbol: string): Promise<DerivForgetResult> {
    const subId = this.subscriptionIdBySymbol.get(derivSymbol) ?? null;
    const wasSubscribed = this.subscribedSymbols.has(derivSymbol) || subId != null;
    this.subscribedSymbols.delete(derivSymbol);
    this.eagerWarmupSymbols.delete(derivSymbol);
    this.subscriptionIdBySymbol.delete(derivSymbol);
    if (!wasSubscribed) {
      return { ok: true, forgot: false, reason: "not_subscribed" };
    }
    if (subId == null) {
      // No retained id → a targeted forget is impossible. forget_all("ticks")
      // is NOT substituted here because it would kill every other consumer's
      // stream. The venue stream may persist until socket death — say so.
      return { ok: true, forgot: false, reason: "no_subscription_id_venue_stream_may_persist_until_socket_death" };
    }
    try {
      const resp = await this.request({ forget: subId });
      const forgot = resp.forget === 1 || resp.forget === true;
      return forgot
        ? { ok: true, forgot: true }
        : { ok: true, forgot: false, reason: "venue_reported_subscription_not_found" };
    } catch (err) {
      return { ok: false, forgot: false, reason: (err as Error).message.slice(0, 200) };
    }
  }

  /** Release EVERY tick stream on this connection via `forget_all: ticks`.
   *  Clears all local subscription bookkeeping first (including the eager
   *  set, so reconnect warm-up starts from its defaults, not the old pins).
   *  `forgottenCount` reflects the venue's own answer; null means the venue
   *  did not enumerate (never fabricated). */
  async forgetAllTicks(): Promise<{ ok: boolean; forgottenCount: number | null; reason?: string }> {
    this.subscribedSymbols.clear();
    this.subscriptionIdBySymbol.clear();
    this.eagerWarmupSymbols.clear();
    try {
      const resp = await this.request({ forget_all: "ticks" });
      const arr = resp.forget_all;
      return { ok: true, forgottenCount: Array.isArray(arr) ? arr.length : null };
    } catch (err) {
      return { ok: false, forgottenCount: null, reason: (err as Error).message.slice(0, 200) };
    }
  }
}

let _client: DerivWsClient | null = null;
export function getDerivWsClient(): DerivWsClient {
  if (!_client) _client = new DerivWsClient();
  return _client;
}
