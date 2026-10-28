import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type WebSocket from "ws";
import { DerivPublicDataClient, DERIV_PUBLIC_DATA_URL, assertPublicDataRequest, normalizePublicTick, normalizePublicCandles } from "../derivPublicDataClient.js";

const known = [
  { symbol: "V75", derivId: "R_75", displayName: "Volatility 75 Index" },
  { symbol: "V75_1S", derivId: "1HZ75V", displayName: "Volatility 75 (1s) Index" },
  { symbol: "STEP", derivId: "stpRNG", displayName: "Step Index" },
];
const epoch = 1_800_000_000;
type Message = Record<string, any>;
const settle = () => new Promise<void>(r => setImmediate(r));
class FakeSocket extends EventEmitter {
  sent: Message[] = [];
  terminated = false;
  onSend?: (message: Message) => void;
  send(data: string) { const message = JSON.parse(data); this.sent.push(message); this.onSend?.(message); }
  terminate() { if (!this.terminated) { this.terminated = true; this.emit("close"); } }
  respond(request: Message, body: Message) { this.emit("message", JSON.stringify({ req_id: request.req_id, ...body })); }
}
function fixture(options: { enabled?: boolean; requestMs?: number; pingMs?: number; reconnectMs?: number; reply?: (socket: FakeSocket, request: Message) => boolean; open?: boolean; factoryFails?: number } = {}) {
  let now = epoch * 1000 + 500;
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  let fails = options.factoryFails ?? 0;
  const client = new DerivPublicDataClient(known, {
    enabled: () => options.enabled !== false, now: () => now, requestMs: options.requestMs ?? 1000,
    pingMs: options.pingMs ?? 60_000, reconnectMs: options.reconnectMs ?? 60_000, random: () => 0.5,
    socket: url => {
      urls.push(url);
      if (fails-- > 0) throw new Error("factory unavailable");
      const socket = new FakeSocket(); sockets.push(socket);
      socket.onSend = request => {
        if (options.reply?.(socket, request)) return;
        if (request.active_symbols) socket.respond(request, { active_symbols: known.map(s => ({ underlying_symbol: s.derivId, underlying_symbol_name: s.displayName, exchange_is_open: 1, is_trading_suspended: 0, market: "synthetic_index" })) });
        if (request.ticks) socket.respond(request, { tick: { symbol: request.ticks, quote: 123, epoch: Math.floor(now / 1000) }, subscription: { id: `sub-${request.ticks}` } });
        if (request.ticks_history) socket.respond(request, { echo_req: request, candles: [{ epoch: Math.floor(now / 60_000) * 60, open: 120, high: 125, low: 119, close: 123 }] });
        if (request.ping) socket.respond(request, { ping: "pong" });
        if (request.forget) socket.respond(request, { forget: 1 });
      };
      if (options.open !== false) queueMicrotask(() => socket.emit("open"));
      return socket as unknown as WebSocket;
    },
  });
  return { client, sockets, urls, setNow: (value: number) => { now = value; }, now: () => now };
}

test("opt-in off refuses connection; private and unknown actions are rejected before opening", async t => {
  const f = fixture({ enabled: false }); t.after(() => f.client.stop());
  await assert.rejects(f.client.request({ active_symbols: "brief" }), /NOT_ENABLED/);
  for (const payload of [{ authorize: "secret" }, { buy: "proposal" }, { balance: 1 }, { ping: 1, token: "secret" }, { ticks: "R_75", authorize: "secret" }, { ticks: "R_75", time: 1 }]) {
    await assert.rejects(f.client.request(payload), /ACTION_REFUSED/);
  }
  assert.equal(f.urls.length, 0);
});

test("public socket uses fixed endpoint and never claims account authorization", async t => {
  const f = fixture(); t.after(() => f.client.stop());
  await f.client.subscribeTicks("R_75");
  assert.deepEqual(f.urls, [DERIV_PUBLIC_DATA_URL]);
  assert.equal(f.client.isConnected(), true); assert.equal(f.client.isAuthorized(), false);
  assert.equal(f.client.getAccountIdentity(), null); assert.equal(f.client.getMode(), "public");
  assert.ok(f.sockets[0]!.sent.every(msg => !["authorize", "buy", "balance", "account_id", "token", "otp"].some(key => key in msg)));
});

test("concurrent discovery, subscriptions and identical history share requests", async t => {
  const f = fixture(); t.after(() => f.client.stop());
  await Promise.all(Array.from({ length: 8 }, () => f.client.subscribeTicks("R_75")));
  await Promise.all(Array.from({ length: 8 }, () => f.client.getCandles("R_75", 60, 200)));
  assert.equal(f.urls.length, 1);
  const sent = f.sockets[0]!.sent;
  assert.equal(sent.filter(m => m.active_symbols).length, 1);
  assert.equal(sent.filter(m => m.ticks).length, 1);
  assert.equal(sent.filter(m => m.ticks_history).length, 1);
});

test("current discovery schema preserves native case and refuses missing/closed instruments", async t => {
  const f = fixture({ reply: (s, r) => {
    if (!r.active_symbols) return false;
    s.respond(r, { active_symbols: [{ underlying_symbol: "stpRNG", exchange_is_open: 1 }, { underlying_symbol: "R_75", exchange_is_open: 1, is_trading_suspended: 1 }] }); return true;
  }}); t.after(() => f.client.stop());
  await f.client.subscribeTicks("stpRNG");
  assert.equal(f.client.isSymbolAvailable("stpRNG"), true);
  assert.equal(f.client.isSymbolAvailable("STPRNG"), false);
  await assert.rejects(f.client.subscribeTicks("R_75"), /SYMBOL_UNAVAILABLE/);
  await assert.rejects(f.client.subscribeTicks("1HZ75V"), /SYMBOL_UNAVAILABLE/);
  await assert.rejects(f.client.subscribeTicks("guessed"), /UNKNOWN_SYMBOL/);
  assert.equal(f.client.getLastDiscoveryValidation()?.missingFromVenue.length, 1);
});

test("empty or legacy-shaped discovery cannot claim public readiness", async t => {
  const f = fixture({ reply: (s,r) => { if (!r.active_symbols) return false; s.respond(r, { active_symbols: [{ symbol: "R_75", exchange_is_open: 1 }] }); return true; }});
  t.after(() => f.client.stop());
  await assert.rejects(f.client.subscribeTicks("R_75"), /EMPTY_DISCOVERY/);
  assert.equal(f.client.isActiveSymbolsLoaded(), false); assert.equal(f.client.hasRecentTick(), false);
});

test("global freshness uses venue epoch, never receive time or another symbol", async t => {
  const f = fixture({ reply: (s,r) => { if (!r.ticks) return false; s.respond(r, { tick: { symbol: r.ticks, quote: 123, epoch: epoch - 120 }, subscription: { id: `sub-${r.ticks}` } }); return true; }});
  t.after(() => f.client.stop()); await f.client.subscribeTicks("R_75");
  assert.equal(f.client.hasRecentTick(), false); assert.equal(f.client.getLastTickAgeMs(), 120500);
  assert.equal(f.client.getCachedTick("1HZ75V"), null);
});

test("invalid, wrong, future, retrograde and conflicting equal-time ticks never overwrite accepted evidence", async t => {
  const f = fixture(); t.after(() => f.client.stop()); await f.client.subscribeTicks("R_75");
  const baseline = f.client.getCachedTick("R_75"); const observed: unknown[] = [];
  f.client.onTick(tick => observed.push(tick));
  for (const tick of [
    { symbol: "R_75", epoch: epoch - 1, quote: 50 }, { symbol: "R_75", epoch, quote: 50 },
    { symbol: "R_75", epoch: epoch + 60, quote: 50 }, { symbol: "R_75", epoch, quote: 0 },
    { symbol: "1HZ75V", epoch, quote: 50 }, { symbol: "R_75", underlying_symbol: "1HZ75V", epoch, quote: 50 },
  ]) f.sockets[0]!.emit("message", JSON.stringify({ tick, subscription: { id: "sub-R_75" } }));
  f.sockets[0]!.emit("message", `{"tick":{"symbol":"R_75","epoch":${epoch},"quote":1e999},"subscription":{"id":"sub-R_75"}}`);
  assert.deepEqual(f.client.getCachedTick("R_75"), baseline); assert.equal(observed.length, 0);
  f.setNow((epoch + 1) * 1000);
  f.sockets[0]!.emit("message", JSON.stringify({ tick: { symbol: "R_75", epoch: epoch + 1, quote: 124 }, subscription: { id: "sub-R_75" } }));
  assert.equal(observed.length, 1); assert.equal(f.client.getCachedTick("R_75")?.quote, 124);
});

test("mismatched subscribe response is forgotten, never relabeled", async t => {
  const f = fixture({ reply: (s,r) => { if (!r.ticks) return false; s.respond(r, { tick: { symbol: "1HZ75V", quote: 99, epoch }, subscription: { id: "wrong" } }); return true; }});
  t.after(() => f.client.stop()); await assert.rejects(f.client.subscribeTicks("R_75"), /INVALID_TICK/);
  assert.equal(f.client.getCachedTick("R_75"), null); assert.deepEqual(f.client.getSubscribedSymbols(), []);
  assert.equal(f.sockets[0]!.sent.filter(r => r.forget === "wrong").length, 1);
});

test("unsubscribe wins over an in-flight subscription and ignores late streams", async t => {
  let pending: Message | null = null;
  const f = fixture({ reply: (_s,r) => { if (!r.ticks) return false; pending = r; return true; }});
  t.after(() => f.client.stop()); const read = f.client.subscribeTicks("R_75"); await settle();
  assert.ok(pending); await f.client.unsubscribeTicks("R_75");
  f.sockets[0]!.respond(pending!, { tick: { symbol: "R_75", epoch, quote: 1 }, subscription: { id: "late" } });
  assert.equal(await read, null); assert.equal(f.client.hasRecentTick(), false);
  assert.ok(f.sockets[0]!.sent.some(r => r.forget === "late"));
});

test("disconnect clears live/history evidence and ignores old socket frames after reconnect", async t => {
  const f = fixture({ reconnectMs: 1 }); t.after(() => f.client.stop());
  await f.client.subscribeTicks("R_75"); await f.client.getCandles("R_75", 60, 5);
  const old = f.sockets[0]!; old.terminate();
  assert.equal(f.client.hasRecentTick(), false); assert.equal(f.client.hasSymbolHistory("R_75"), false);
  assert.equal(f.client.getCachedTick("R_75"), null);
  await new Promise(r => setTimeout(r, 15)); await settle();
  assert.equal(f.sockets.length, 2); assert.equal(f.client.isConnected(), true);
  old.emit("message", JSON.stringify({ tick: { symbol: "R_75", epoch, quote: 999 }, subscription: { id: "sub-R_75" } }));
  assert.equal(f.client.getCachedTick("R_75")?.quote, 123);
});

test("expired discovery is refreshed by subscribed reads before ticks regain readiness", async t => {
  const f = fixture(); t.after(() => f.client.stop()); await f.client.subscribeTicks("R_75");
  f.setNow(f.now() + 300_001); assert.equal(f.client.isActiveSymbolsLoaded(), false);
  await f.client.subscribeTicks("R_75");
  assert.equal(f.sockets[0]!.sent.filter(r => r.active_symbols).length, 2);
  assert.equal(f.client.isActiveSymbolsLoaded(), true); assert.equal(f.client.hasRecentTick(), false);
});

test("half-open ping timeout clears readiness and starts bounded reconnect", async t => {
  const f = fixture({ requestMs: 10, pingMs: 10, reconnectMs: 60_000, reply: (_s,r) => !!r.ping });
  t.after(() => f.client.stop()); await f.client.subscribeTicks("R_75");
  await new Promise(r => setTimeout(r, 45));
  assert.equal(f.client.isConnected(), false); assert.equal(f.client.hasRecentTick(), false); assert.equal(f.sockets[0]!.terminated, true);
  await assert.rejects(f.client.request({ time: 1 }), /BACKOFF/); assert.equal(f.sockets.length, 1);
});

test("synchronous socket construction failure can recover after backoff", async t => {
  const f = fixture({ factoryFails: 1, reconnectMs: 1 }); t.after(() => f.client.stop());
  await assert.rejects(f.client.subscribeTicks("R_75"), /CONNECTION_FAILED/);
  await new Promise(r => setTimeout(r, 15));
  await f.client.subscribeTicks("R_75"); assert.equal(f.urls.length, 2); assert.equal(f.client.hasRecentTick(), true);
});

test("late open after handshake timeout cannot resurrect the failed socket", async t => {
  const f = fixture({ open: false, requestMs: 10 }); t.after(() => f.client.stop());
  await assert.rejects(f.client.request({ time: 1 }), /CONNECTION_FAILED/);
  f.sockets[0]!.emit("open"); assert.equal(f.client.isConnected(), false); assert.equal(f.sockets[0]!.sent.length, 0);
});

test("history validates OHLC/order and preserves provider time including 5000-bar caller limit", async t => {
  const f = fixture(); t.after(() => f.client.stop());
  const result = await f.client.getCandles("R_75", 60, 2000);
  assert.equal(f.sockets[0]!.sent.find(r => r.ticks_history)?.count, 2000);
  assert.equal(f.client.getLastCandleAt(), new Date(result[0]!.epoch * 1000).toISOString());
  assert.equal(f.client.hasSymbolHistory("1HZ75V"), false);
  const candle = { epoch: epoch - 60, open: 10, high: 11, low: 9, close: 10 };
  for (const raw of [[{ ...candle, high: 5 }], [{ ...candle, close: Infinity }], [{ ...candle, epoch: epoch + 1 }], [candle,candle], [{ ...candle, low: -1 }]]) assert.throws(() => normalizePublicCandles(raw, epoch * 1000), /INVALID_CANDLES/);
  assert.equal(normalizePublicTick({ symbol: "R_75", epoch, quote: NaN }, "R_75", epoch * 1000), null);
  assert.throws(() => assertPublicDataRequest({ ticks_history: "R_75", style: "candles", count: 2, end: "latest", granularity: 604800 }), /INVALID_REQUEST/);
});

test("history refuses an echo naming another instrument", async t => {
  const f = fixture({ reply: (s,r) => { if (!r.ticks_history) return false; s.respond(r, { echo_req: { ticks_history: "1HZ75V" }, candles: [] }); return true; }});
  t.after(() => f.client.stop()); await assert.rejects(f.client.getCandles("R_75", 60, 5), /SYMBOL_MISMATCH/);
  assert.equal(f.client.getLastCandleAt(), null);
});

test("bounded requests refuse overload and stop rejects all pending work", async t => {
  const f = fixture({ reply: (_s,r) => !!r.time }); t.after(() => f.client.stop());
  await f.client.subscribeTicks("R_75");
  const reads = Array.from({ length: 70 }, () => f.client.request({ time: 1 }).then(() => "ok", e => e.message));
  await settle(); f.client.stop();
  const results = await Promise.all(reads);
  assert.equal(results.filter(r => r === "DERIV_PUBLIC_BUSY").length, 6);
  assert.equal(results.filter(r => r === "DERIV_PUBLIC_DISCONNECTED").length, 64);
  assert.equal(f.client.isConnected(), false);
});

test("resolved frames from a closing session cannot publish ticks or candle readiness", async t => {
  for (const action of ["ticks", "ticks_history"]) {
    const f = fixture({ reply: (s,r) => {
      if (!r[action]) return false;
      s.respond(r, action === "ticks"
        ? { tick: { symbol: "R_75", epoch, quote: 123 }, subscription: { id: "closing" } }
        : { candles: [{ epoch, open: 120, high: 125, low: 119, close: 123 }] });
      s.terminate(); return true;
    }}); t.after(() => f.client.stop());
    await assert.rejects(action === "ticks" ? f.client.subscribeTicks("R_75") : f.client.getCandles("R_75", 60, 5), /SESSION_CHANGED/);
    assert.equal(f.client.hasRecentTick(), false); assert.equal(f.client.getLastCandleAt(), null);
  }
});

test("a missing subscription acknowledgement closes the untracked venue stream", async t => {
  const f = fixture({ requestMs: 10, reply: (_s,r) => !!r.ticks }); t.after(() => f.client.stop());
  await assert.rejects(f.client.subscribeTicks("R_75"), /REQUEST_TIMEOUT/);
  assert.equal(f.sockets[0]!.terminated, true); assert.equal(f.client.isConnected(), false);
});

test("public request budget refuses bursts while ping remains available", async t => {
  const f = fixture({ reply: (s,r) => { if (!r.time) return false; s.respond(r, { time: epoch }); return true; }}); t.after(() => f.client.stop());
  await f.client.subscribeTicks("R_75"); // discovery + subscription = 2 charged reads
  for (let i = 0; i < 178; i++) await f.client.request({ time: 1 });
  await assert.rejects(f.client.request({ time: 1 }), /RATE_LIMITED/);
  await f.client.request({ ping: 1 });
  assert.equal(f.sockets[0]!.sent.filter(r => !r.ping).length, 180);
});
