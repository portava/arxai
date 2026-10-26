// Public market data only. This connection never reads credentials, creates an
// account session, sends authorize/OTP, or accepts an order/account operation.
import WebSocket from "ws";
import type { DerivCandle, DerivGranularity, DerivTick, DerivTickListener } from "./derivWsClient.js";
import { parseActiveSymbols, validateKnownMap, type DerivDiscoverySnapshot, type KnownDerivMapEntry } from "./derivSymbolDiscovery.js";

export const DERIV_PUBLIC_DATA_URL = "wss://api.derivws.com/trading/v1/options/ws/public";
export const derivPublicDataEnabled = () => process.env.ARX_DERIV_PUBLIC_DATA_ENABLED === "true";
const ERROR = (code: string) => new Error(code);
const FRESH_MS = 30_000;
const DISCOVERY_MS = 300_000;
const ACTION_KEYS: Record<string, readonly string[]> = {
  ping: ["ping"], time: ["time"], active_symbols: ["active_symbols"],
  ticks: ["ticks", "subscribe"],
  ticks_history: ["ticks_history", "end", "style", "granularity", "count"],
  forget: ["forget"],
};

/** Positive field/action allow-list. Reject before socket creation or sending. */
export function assertPublicDataRequest(payload: Record<string, unknown>): void {
  const keys = Object.keys(payload);
  const actions = keys.filter((key) => Object.hasOwn(ACTION_KEYS, key));
  if (actions.length !== 1 || keys.some((key) => !ACTION_KEYS[actions[0]!]!.includes(key))) throw ERROR("DERIV_PUBLIC_ACTION_REFUSED");
  const action = actions[0]!;
  if ((action === "ping" || action === "time") && payload[action] !== 1) throw ERROR("DERIV_PUBLIC_INVALID_REQUEST");
  if (action === "active_symbols" && payload.active_symbols !== "brief") throw ERROR("DERIV_PUBLIC_INVALID_REQUEST");
  if ((action === "ticks" || action === "ticks_history") && (typeof payload[action] !== "string" || !/^\w{2,30}$/.test(payload[action] as string))) throw ERROR("DERIV_PUBLIC_INVALID_REQUEST");
  if (action === "ticks" && payload.subscribe !== undefined && payload.subscribe !== 1) throw ERROR("DERIV_PUBLIC_INVALID_REQUEST");
  if (action === "forget" && (typeof payload.forget !== "string" || payload.forget.length > 256 || !payload.forget)) throw ERROR("DERIV_PUBLIC_INVALID_REQUEST");
  if (action === "ticks_history" && (payload.style !== "candles" || ![60,120,180,300,600,900,1800,3600,7200,14400,28800,86400].includes(payload.granularity as number) || !Number.isInteger(payload.count) || (payload.count as number) < 1 || (payload.count as number) > 5000 || !(payload.end === "latest" || (Number.isInteger(payload.end) && (payload.end as number) > 0)))) throw ERROR("DERIV_PUBLIC_INVALID_REQUEST");
}

const record = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null ? value as Record<string, unknown> : null;

/** The new public schema names the instrument underlying_symbol. Never guess. */
export function normalizePublicTick(raw: unknown, expected: string, now: number): DerivTick | null {
  const t = record(raw);
  if (!t || t.symbol !== undefined && t.underlying_symbol !== undefined && t.symbol !== t.underlying_symbol) return null;
  if ((t.underlying_symbol ?? t.symbol) !== expected || typeof t.epoch !== "number" || !Number.isSafeInteger(t.epoch) || t.epoch <= 0 || t.epoch * 1000 > now || typeof t.quote !== "number" || !Number.isFinite(t.quote) || t.quote <= 0) return null;
  return { symbol: expected, epoch: t.epoch, quote: t.quote };
}

export function normalizePublicCandles(raw: unknown, now: number): DerivCandle[] {
  if (!Array.isArray(raw) || raw.length > 5000) throw ERROR("DERIV_PUBLIC_INVALID_CANDLES");
  const candles: DerivCandle[] = [];
  for (const value of raw) {
    const c = record(value);
    if (!c || typeof c.epoch !== "number" || !Number.isSafeInteger(c.epoch) || c.epoch <= 0 || c.epoch * 1000 > now || ["open","high","low","close"].some(k => typeof c[k] !== "number" || !Number.isFinite(c[k]) || (c[k] as number) <= 0) || (c.high as number) < Math.max(c.open as number,c.close as number,c.low as number) || (c.low as number) > Math.min(c.open as number,c.close as number,c.high as number) || candles.length > 0 && c.epoch <= candles[candles.length - 1]!.epoch) throw ERROR("DERIV_PUBLIC_INVALID_CANDLES");
    candles.push({ epoch: c.epoch, open: c.open as number, high: c.high as number, low: c.low as number, close: c.close as number });
  }
  return candles;
}

interface Options {
  enabled?: () => boolean;
  now?: () => number;
  socket?: (url: string) => WebSocket;
  requestMs?: number;
  reconnectMs?: number;
  pingMs?: number;
  random?: () => number;
}
interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }

export class DerivPublicDataClient {
  private readonly enabled: () => boolean;
  private readonly now: () => number;
  private readonly socket: (url: string) => WebSocket;
  private readonly requestMs: number;
  private ws: WebSocket | null = null;
  private connected = false;
  private disconnect: (() => void) | null = null;
  private stopped = false;
  private generation = 0;
  private nextId = 0;
  private opening: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private ticks = new Map<string, DerivTick>();
  private listeners = new Set<DerivTickListener>();
  private desired = new Set<string>();
  private subscriptions = new Map<string, string>();
  private subscriptionPromises = new Map<string, Promise<DerivTick | null>>();
  private intentVersions = new Map<string, number>();
  private candlePromises = new Map<string, Promise<DerivCandle[]>>();
  private discovery: DerivDiscoverySnapshot | null = null;
  private discoveryPromise: Promise<void> | null = null;
  private lastCandle: number | null = null;
  private historySymbols = new Set<string>();
  private connectedAt: number | null = null;
  private lastError: string | null = null;
  private discoveryError: string | null = null;
  private reconnects = 0;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private sentAt: number[] = [];
  private warmupAt: number | null = null;
  private warmedAt: number | null = null;

  constructor(private readonly known: readonly KnownDerivMapEntry[], private readonly options: Options = {}) {
    this.enabled = options.enabled ?? derivPublicDataEnabled;
    this.now = options.now ?? Date.now;
    this.socket = options.socket ?? ((url) => new WebSocket(url, { maxPayload: 2 * 1024 * 1024 }));
    this.requestMs = options.requestMs ?? 8_000;
  }
  configured() { return this.enabled(); }
  getMode() { return "public" as const; }
  isConnected() { return this.connected && this.configured(); }
  isAuthorized() { return false; }
  getAccountIdentity() { return null; }
  getAccountIdConfigured() { return false; }
  getMaskedAppId() { return "Not required for public data"; }
  getMaskedToken() { return "Not required for public data"; }
  getLastAuthorizeError() { return null; }
  getLastAuthorizeErrorCode() { return null; }
  getOtpLastResult() { return null; }
  getLastErrorMessage() { return this.lastError; }
  getReconnectCount() { return this.reconnects; }
  getSubscribedSymbols() { return [...this.subscriptions.keys()]; }
  getEagerWarmupSymbols() { return [...this.desired]; }
  getConnectedAt() { return this.connectedAt === null ? null : new Date(this.connectedAt).toISOString(); }
  getWarmupAttemptedAt() { return this.warmupAt === null ? null : new Date(this.warmupAt).toISOString(); }
  getWarmupCompletedAt() { return this.warmedAt === null ? null : new Date(this.warmedAt).toISOString(); }
  getLastDiscovery() { return this.discovery; }
  getLastDiscoveryAgeMs() { return this.discovery ? this.now() - this.discovery.fetchedAtMs : null; }
  getLastDiscoveryValidation() { return this.discovery ? validateKnownMap(this.discovery.symbols, this.known) : null; }
  isActiveSymbolsLoaded() { return this.isConnected() && !!this.discovery?.symbols.length && this.now() >= this.discovery.fetchedAtMs && this.now() - this.discovery.fetchedAtMs <= DISCOVERY_MS; }
  getActiveSymbolsCount() { return this.discovery?.symbols.length ?? null; }
  getActiveSymbolsLoadedAt() { return this.discovery?.fetchedAt ?? null; }
  getActiveSymbolsError() { return this.discoveryError; }
  hasSymbolHistory(symbol: string) { return this.isConnected() && this.historySymbols.has(symbol); }
  getLastCandleAt() { return this.lastCandle === null ? null : new Date(this.lastCandle * 1000).toISOString(); }
  getCachedTickByDerivId(symbol: string) { return this.isConnected() && this.isSymbolAvailable(symbol) ? this.ticks.get(symbol) ?? null : null; }
  getCachedTick(symbol: string) { return this.getCachedTickByDerivId(symbol); }
  getLastTickAt() { const epoch = this.lastTickEpoch(); return epoch === null ? null : new Date(epoch * 1000).toISOString(); }
  getLastTickAgeMs() { const epoch = this.lastTickEpoch(); return epoch === null ? null : this.now() - epoch * 1000; }
  hasRecentTick(maxAgeMs = FRESH_MS) { const age = this.getLastTickAgeMs(); return this.isConnected() && age !== null && age >= 0 && age <= maxAgeMs; }
  private lastTickEpoch() { const epochs = this.getSubscribedSymbols().flatMap(s => { const tick = this.getCachedTick(s); return tick ? [tick.epoch] : []; }); return epochs.length ? Math.max(...epochs) : null; }
  isSymbolAvailable(symbol: string) { return this.isActiveSymbolsLoaded() && this.known.some(s => s.derivId === symbol) && this.discovery!.symbols.some(s => s.symbol === symbol && s.exchangeIsOpen); }
  onTick(listener: DerivTickListener) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  ensureConnection(): void { void this.open().catch(() => {}); }
  private open(): Promise<void> {
    if (!this.configured() || this.stopped) return Promise.reject(ERROR("DERIV_PUBLIC_NOT_ENABLED"));
    if (this.connected) return Promise.resolve();
    if (this.opening) return this.opening;
    if (this.retryTimer) return Promise.reject(ERROR("DERIV_PUBLIC_RECONNECT_BACKOFF"));
    const generation = ++this.generation;
    const opening = new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      let opened = false;
      let finished = false;
      const fail = () => {
        if (finished || generation !== this.generation) return;
        finished = true;
        clearTimeout(timeout);
        this.connected = false; this.connectedAt = null; this.opening = null;
        this.disconnect = null; this.ws = null;
        this.discovery = null; this.discoveryPromise = null; this.ticks.clear(); this.subscriptions.clear();
        this.subscriptionPromises.clear(); this.candlePromises.clear(); this.lastCandle = null; this.historySymbols.clear();
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(ERROR("DERIV_PUBLIC_DISCONNECTED")); }
        this.pending.clear();
        this.lastError = "DERIV_PUBLIC_DISCONNECTED";
        if (!opened) reject(ERROR("DERIV_PUBLIC_CONNECTION_FAILED"));
        if (!this.stopped && this.configured()) {
          const delay = Math.min(30_000, (this.options.reconnectMs ?? 1_000) * 2 ** Math.min(this.failures++, 5)) * (0.8 + 0.4 * (this.options.random ?? Math.random)());
          this.retryTimer = setTimeout(() => { this.retryTimer = null; this.reconnects++; this.ensureConnection(); }, delay);
          this.retryTimer.unref?.();
        }
      };
      this.disconnect = () => { fail(); ws?.terminate(); };
      const timeout = setTimeout(() => { fail(); ws?.terminate(); }, this.requestMs);
      try { ws = this.socket(DERIV_PUBLIC_DATA_URL); this.ws = ws; } catch { fail(); return; }
      ws.on("open", () => {
        if (finished || generation !== this.generation || this.stopped || !this.configured()) { ws.terminate(); return; }
        opened = true; clearTimeout(timeout); this.connected = true; this.connectedAt = this.now(); this.opening = null; this.lastError = null;
        resolve();
        this.pingTimer = setInterval(() => {
          // A half-open socket must not retain a connected badge indefinitely.
          void this.request({ ping: 1 }).then(() => this.discover()).catch(() => {
            if (generation === this.generation) this.disconnect?.();
          });
        }, this.options.pingMs ?? 30_000);
        this.pingTimer.unref?.();
        void this.warmup(generation);
      });
      ws.on("message", data => { if (generation === this.generation && this.connected && !finished) this.receive(String(data)); });
      ws.on("error", () => { fail(); ws.terminate(); });
      ws.on("close", fail);
    });
    this.opening = opening;
    // Synchronous factory failure must not poison all later connection attempts.
    void opening.catch(() => { if (this.opening === opening) this.opening = null; });
    return opening;
  }

  private requireSession(generation: number): void {
    if (generation !== this.generation || !this.isConnected()) throw ERROR("DERIV_PUBLIC_SESSION_CHANGED");
  }

  async request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    assertPublicDataRequest(payload);
    await this.open();
    if (!this.connected || !this.ws) throw ERROR("DERIV_PUBLIC_DISCONNECTED");
    if (this.pending.size >= 64) throw ERROR("DERIV_PUBLIC_BUSY");
    const now = this.now();
    this.sentAt = this.sentAt.filter(t => now - t < 3_600_000);
    // Keep headroom below the venue's shared public 220/minute and 14,400/hour.
    if (!payload.ping && (this.sentAt.length >= 10_000 || this.sentAt.filter(t => now - t < 60_000).length >= 180)) throw ERROR("DERIV_PUBLIC_RATE_LIMITED");
    if (!payload.ping) this.sentAt.push(now);
    const req_id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(ERROR("DERIV_PUBLIC_REQUEST_TIMEOUT"));
        // An unacknowledged subscription may already exist at the venue. Close
        // the session to release it instead of leaking an untracked stream.
        if (payload.subscribe === 1) this.disconnect?.();
      }, this.requestMs);
      this.pending.set(req_id, { resolve, reject, timer });
      try { this.ws!.send(JSON.stringify({ ...payload, req_id })); } catch { clearTimeout(timer); this.pending.delete(req_id); reject(ERROR("DERIV_PUBLIC_SEND_FAILED")); }
    });
  }

  private receive(raw: string): void {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!record(msg)) return;
    const p = typeof msg.req_id === "number" ? this.pending.get(msg.req_id) : undefined;
    if (p) {
      clearTimeout(p.timer); this.pending.delete(msg.req_id as number);
      const error = record(msg.error);
      if (error) { const code = typeof error.code === "string" && /^[A-Za-z0-9_]{1,80}$/.test(error.code) ? error.code : "UNKNOWN"; p.reject(ERROR(`DERIV_PUBLIC_${code}`)); }
      else p.resolve(msg);
    }
    const tick = record(msg.tick);
    const symbol = tick?.underlying_symbol ?? tick?.symbol;
    const sub = record(msg.subscription)?.id;
    // Ignore unsolicited, late-forgotten, previous-session and mismatched streams.
    if (typeof symbol === "string" && typeof sub === "string" && this.subscriptions.get(symbol) === sub && this.desired.has(symbol)) this.acceptTick(tick, symbol);
  }
  private acceptTick(raw: unknown, symbol: string): DerivTick | null {
    if (!this.isSymbolAvailable(symbol)) return null;
    const tick = normalizePublicTick(raw, symbol, this.now());
    const prior = this.ticks.get(symbol);
    if (!tick || prior && (tick.epoch < prior.epoch || tick.epoch === prior.epoch && tick.quote !== prior.quote)) return prior ?? null;
    if (prior?.epoch === tick.epoch) return prior;
    this.ticks.set(symbol, tick);
    for (const listener of this.listeners) { try { listener(tick); } catch { /* observers do not own transport */ } }
    return tick;
  }
  private async discover(): Promise<void> {
    if (this.isActiveSymbolsLoaded()) return;
    if (this.discoveryPromise) return this.discoveryPromise;
    const work = (async () => {
      await this.open();
      const generation = this.generation;
      const msg = await this.request({ active_symbols: "brief" });
      this.requireSession(generation);
      const rows = Array.isArray(msg.active_symbols) ? msg.active_symbols : [];
      const normalized = rows.flatMap(value => {
        const row = record(value);
        if (!row || typeof row.underlying_symbol !== "string" || row.symbol !== undefined && row.symbol !== row.underlying_symbol) return [];
        return [{ ...row, symbol: row.underlying_symbol, display_name: row.underlying_symbol_name, exchange_is_open: row.is_trading_suspended ? 0 : row.exchange_is_open }];
      });
      const symbols = parseActiveSymbols(normalized);
      if (!symbols.length) throw ERROR("DERIV_PUBLIC_EMPTY_DISCOVERY");
      const now = this.now(); this.discovery = { fetchedAt: new Date(now).toISOString(), fetchedAtMs: now, symbols }; this.discoveryError = null; this.failures = 0;
    })();
    this.discoveryPromise = work;
    try { await work; } catch (err) { this.discoveryError = (err as Error).message; throw err; }
    finally { if (this.discoveryPromise === work) this.discoveryPromise = null; }
  }
  private async warmup(generation: number) {
    this.warmupAt = this.now();
    try {
      await this.discover();
      for (const symbol of this.desired) { if (generation !== this.generation) return; await this.subscribeTicks(symbol).catch(() => {}); }
      if (generation === this.generation) this.warmedAt = this.now();
    } catch { /* diagnostic state carries discovery error; on-demand reads retry */ }
  }
  async subscribeTicks(symbol: string): Promise<DerivTick | null> {
    if (!this.known.some(s => s.derivId === symbol)) throw ERROR("DERIV_PUBLIC_UNKNOWN_SYMBOL");
    this.desired.add(symbol);
    const existing = this.subscriptionPromises.get(symbol); if (existing) return existing;
    const version = this.intentVersions.get(symbol) ?? 0;
    const work = (async () => {
      await this.open(); const generation = this.generation; await this.discover();
      this.requireSession(generation);
      if (this.subscriptions.has(symbol)) return this.getCachedTick(symbol);
      if (!this.isSymbolAvailable(symbol)) throw ERROR("DERIV_PUBLIC_SYMBOL_UNAVAILABLE");
      const msg = await this.request({ ticks: symbol, subscribe: 1 });
      this.requireSession(generation);
      const id = record(msg.subscription)?.id;
      if (typeof id !== "string" || !id) throw ERROR("DERIV_PUBLIC_INVALID_SUBSCRIPTION");
      if (version !== (this.intentVersions.get(symbol) ?? 0) || !this.desired.has(symbol)) { await this.request({ forget: id }); return null; }
      if (!normalizePublicTick(msg.tick, symbol, this.now())) { await this.request({ forget: id }); throw ERROR("DERIV_PUBLIC_INVALID_TICK"); }
      this.subscriptions.set(symbol, id);
      return this.acceptTick(msg.tick, symbol);
    })();
    this.subscriptionPromises.set(symbol, work);
    try { return await work; } finally { if (this.subscriptionPromises.get(symbol) === work) this.subscriptionPromises.delete(symbol); }
  }
  async unsubscribeTicks(symbol: string) {
    if (!this.known.some(s => s.derivId === symbol)) return { ok: false, forgot: false, reason: "DERIV_PUBLIC_UNKNOWN_SYMBOL" };
    this.intentVersions.set(symbol, (this.intentVersions.get(symbol) ?? 0) + 1);
    this.desired.delete(symbol); this.ticks.delete(symbol);
    const id = this.subscriptions.get(symbol); this.subscriptions.delete(symbol);
    if (!id) return { ok: true, forgot: false, reason: "not_subscribed" };
    try { const result = await this.request({ forget: id }); return { ok: true, forgot: result.forget === 1 || result.forget === true }; }
    catch { return { ok: false, forgot: false, reason: "DERIV_PUBLIC_FORGET_UNCONFIRMED" }; }
  }
  async getCandles(symbol: string, granularity: DerivGranularity, count: number, end?: number): Promise<DerivCandle[]> {
    if (!this.known.some(s => s.derivId === symbol)) throw ERROR("DERIV_PUBLIC_UNKNOWN_SYMBOL");
    const payload = { ticks_history: symbol, style: "candles", granularity, count: Math.max(1, Math.min(5000, Math.trunc(count))), end: end ?? "latest" };
    assertPublicDataRequest(payload);
    const key = JSON.stringify(payload); const prior = this.candlePromises.get(key); if (prior) return prior;
    if (this.candlePromises.size >= 32) throw ERROR("DERIV_PUBLIC_BUSY");
    const work = (async () => {
      await this.open(); const generation = this.generation; await this.discover();
      this.requireSession(generation);
      if (!this.isSymbolAvailable(symbol)) throw ERROR("DERIV_PUBLIC_SYMBOL_UNAVAILABLE");
      const msg = await this.request(payload);
      this.requireSession(generation);
      const echo = record(msg.echo_req);
      if (echo && echo.ticks_history !== undefined && echo.ticks_history !== symbol) throw ERROR("DERIV_PUBLIC_SYMBOL_MISMATCH");
      const candles = normalizePublicCandles(msg.candles, this.now());
      if (candles.length) { this.lastCandle = Math.max(this.lastCandle ?? 0, candles[candles.length - 1]!.epoch); this.historySymbols.add(symbol); }
      return candles;
    })();
    this.candlePromises.set(key, work);
    try { return await work; } finally { if (this.candlePromises.get(key) === work) this.candlePromises.delete(key); }
  }
  async probe() {
    let activeSymbolsError: string | null = null, ticksHistoryError: string | null = null;
    let ticksHistoryCount: number | null = null, lastCandleEpoch: number | null = null;
    try { await this.open(); await this.discover(); } catch (err) { activeSymbolsError = (err as Error).message; }
    try { const candles = await this.getCandles("R_75", 60, 5); ticksHistoryCount = candles.length; lastCandleEpoch = candles.at(-1)?.epoch ?? null; } catch (err) { ticksHistoryError = (err as Error).message; }
    return { connected: this.isConnected(), authorized: false, activeSymbolsCount: this.getActiveSymbolsCount(), activeSymbolsError, ticksHistoryCount, lastCandleEpoch, ticksHistoryError };
  }
  stop(): void { this.stopped = true; if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = null; this.disconnect?.(); }
}
