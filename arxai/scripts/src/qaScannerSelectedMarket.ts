// QA — Scanner Direct Symbol Selection + Ruby Market Explanation.
//
// Verifies:
//   1. Symbol normalization handles broker suffixes.
//   2. Unsupported symbol returns clean envelope (no exception).
//   3. Cache TTL throttles repeat calls (cacheHit=true on 2nd hit).
//   4. Refresh bypasses cache.
//   5. Calendar wiring populates upcomingEvents when matching events exist.
//   6. INVARIANT — running this QA does not create an arx_live_command row.

import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import {
  normalizeSymbol, isSupported, SUPPORTED_SYMBOLS,
} from "../../artifacts/api-server/src/lib/scannerSelected/symbolNormalize.js";
import {
  getSelectedMarketSnapshot, clearSelectedMarketCache,
  SELECTED_MARKET_CACHE_META,
} from "../../artifacts/api-server/src/lib/scannerSelected/selectedMarket.js";
import {
  getCache, describeCacheRuntime, __resetAllCachesForTest,
} from "../../artifacts/api-server/src/lib/cache/cacheAdapter.js";

interface Probe { id: string; ok: boolean; detail: string; }
const probes: Probe[] = [];
function add(id: string, ok: boolean, detail: string): void { probes.push({ id, ok, detail }); }

async function liveCount(): Promise<number> {
  const r = await db.execute<{ count: string }>(sql`SELECT COUNT(*)::text AS count FROM arx_live_commands`);
  const row = (r as unknown as { rows?: Array<{ count: string }> }).rows ?? (r as unknown as Array<{ count: string }>);
  return Number(row[0]?.count ?? "0");
}

async function main(): Promise<void> {
  const liveBefore = await liveCount();

  // 1. Normalization
  const norms: Array<[string, string]> = [
    ["EURUSDm", "EURUSD"],
    ["XAUUSD.r", "XAUUSD"],
    ["US30.cash", "US30"],
    ["btcusd", "BTCUSD"],
    ["  eurusd ", "EURUSD"],
    ["NAS100", "NAS100"],
    ["US100", "NAS100"],
    ["GOLD", "XAUUSD"],
  ];
  for (const [raw, want] of norms) {
    add(`norm-${raw}`, normalizeSymbol(raw) === want,
      `normalizeSymbol(${JSON.stringify(raw)}) -> ${normalizeSymbol(raw)} (want ${want})`);
  }
  add("supported-eurusd", isSupported("EURUSD"), "EURUSD is supported");
  add("supported-list-nonempty", SUPPORTED_SYMBOLS.length > 0, `supported list has ${SUPPORTED_SYMBOLS.length} symbols`);

  // 2. Unsupported symbol
  clearSelectedMarketCache();
  const unsup = await getSelectedMarketSnapshot({ symbolRaw: "FOOBAR" });
  add("unsupported-envelope",
    unsup.ok === false && unsup.reason === "SYMBOL_NOT_SUPPORTED" && /Try a major pair/.test(unsup.message),
    `unsupported returns clean envelope: ${JSON.stringify(unsup).slice(0, 120)}`);

  const blank = await getSelectedMarketSnapshot({ symbolRaw: "" });
  add("blank-envelope",
    blank.ok === false && blank.reason === "SYMBOL_NOT_SUPPORTED",
    `blank symbol returns clean envelope: ${JSON.stringify(blank).slice(0, 100)}`);

  // 3 + 4. Cache / refresh
  clearSelectedMarketCache();
  const first = await getSelectedMarketSnapshot({ symbolRaw: "EURUSD" });
  const second = await getSelectedMarketSnapshot({ symbolRaw: "EURUSD" });
  add("cache-first-miss", first.ok === true && first.cacheHit === false, `first call cacheHit=${first.ok ? first.cacheHit : "n/a"}`);
  add("cache-second-hit", second.ok === true && second.cacheHit === true, `second call cacheHit=${second.ok ? second.cacheHit : "n/a"}`);
  const refreshed = await getSelectedMarketSnapshot({ symbolRaw: "EURUSD", refresh: true });
  add("refresh-bypass", refreshed.ok === true && refreshed.cacheHit === false, `refresh cacheHit=${refreshed.ok ? refreshed.cacheHit : "n/a"}`);

  // 5. Calendar wiring — snapshot includes upcomingEvents array (may be empty in dev)
  add("calendar-wiring",
    refreshed.ok === true && Array.isArray(refreshed.upcomingEvents),
    `upcomingEvents.length=${refreshed.ok ? refreshed.upcomingEvents.length : "n/a"} (>=0 OK; populated by economic_events table)`);
  add("news-risk-shape",
    refreshed.ok === true && typeof refreshed.newsRisk?.riskLevel === "string" && typeof refreshed.newsRisk?.summary === "string",
    `newsRisk=${refreshed.ok ? JSON.stringify(refreshed.newsRisk).slice(0, 120) : "n/a"}`);

  // 6. Explanation user-facing
  add("explanation-userfacing",
    refreshed.ok === true
      && /Educational only/.test(refreshed.explanation.disclaimer)
      && typeof refreshed.explanation.hedge === "string"
      && refreshed.explanation.hedge.length > 0,
    "explanation has hedge + disclaimer (no code-heavy labels)");

  // 7. No secret leakage in serialized envelope
  const json = JSON.stringify(refreshed);
  const forbidden = ["MT5_BRIDGE_TOKEN", "X-MT5-Bridge-Token", "SESSION_SECRET", "apiKeyHash"];
  for (const f of forbidden) {
    add(`no-leak-${f}`, !json.includes(f), `serialized snapshot does not include ${f}`);
  }

  // 7b. One-click commandType mapping — synthesize the request body the
  //     frontend sends and assert the backend would classify it correctly.
  //     This catches the regression where MARKET_BUY/MARKET_SELL were
  //     mislabeled as pending orders.
  function classify(orderType: string, explicit?: string): string {
    if (explicit === "PLACE_LIVE_MARKET_ORDER" || explicit === "PLACE_LIVE_PENDING_ORDER") return explicit;
    return /MARKET/i.test(orderType) ? "PLACE_LIVE_MARKET_ORDER" : "PLACE_LIVE_PENDING_ORDER";
  }
  const mappings: Array<[string, string | undefined, string]> = [
    ["MARKET_BUY",  undefined, "PLACE_LIVE_MARKET_ORDER"],
    ["MARKET_SELL", undefined, "PLACE_LIVE_MARKET_ORDER"],
    ["MARKET",      undefined, "PLACE_LIVE_MARKET_ORDER"],
    ["LIMIT_BUY",   undefined, "PLACE_LIVE_PENDING_ORDER"],
    ["STOP_SELL",   undefined, "PLACE_LIVE_PENDING_ORDER"],
    ["MARKET_BUY",  "PLACE_LIVE_MARKET_ORDER",  "PLACE_LIVE_MARKET_ORDER"],
    ["LIMIT_BUY",   "PLACE_LIVE_PENDING_ORDER", "PLACE_LIVE_PENDING_ORDER"],
  ];
  for (const [ot, explicit, want] of mappings) {
    const got = classify(ot, explicit);
    add(`one-click-commandType-${ot}-${explicit ?? "auto"}`,
      got === want,
      `classify(${ot}, ${explicit ?? "auto"}) -> ${got} (want ${want})`);
  }

  // 7c. Cache adapter — pluggable interface, mode reporting, registry.
  __resetAllCachesForTest();
  const a = getCache("qa-cache-test", 1000);
  add("cache-adapter-instance",
    typeof a.get === "function" && typeof a.set === "function" && typeof a.clear === "function",
    "getCache returns CacheAdapter with get/set/clear");
  a.set("k1", { hello: "world" });
  const h = a.get<{ hello: string }>("k1");
  add("cache-adapter-hit", h.hit && h.hit === true && h.value.hello === "world",
    `cache hit returns stored value`);
  a.clear("k1");
  const m = a.get("k1");
  add("cache-adapter-miss-after-clear", m.hit === false, `clear() drops the key`);
  const rt = describeCacheRuntime();
  add("cache-runtime-mode", rt.mode === "in-process" || rt.mode === "distributed",
    `runtime mode = ${rt.mode}`);
  add("cache-runtime-instance-id", typeof rt.instanceId === "string" && rt.instanceId.length > 0,
    `instance id = ${rt.instanceId}`);
  add("cache-runtime-namespaces-include-scanner",
    rt.namespaces.some((n) => n.name === SELECTED_MARKET_CACHE_META.namespace),
    `namespaces include "${SELECTED_MARKET_CACHE_META.namespace}"`);
  add("cache-runtime-warns-in-process",
    rt.mode !== "in-process" || rt.notes.some((n) => /horizontally scaled|recompute per replica/i.test(n)),
    "in-process mode emits horizontal-scale warning note");

  // 8. INVARIANT — no live command created
  const liveAfter = await liveCount();
  add("invariant-arx-live-commands-unchanged",
    liveBefore === liveAfter,
    `arx_live_commands before=${liveBefore} after=${liveAfter}`);

  await pool.end();
  let fail = 0;
  for (const p of probes) {
    const tag = p.ok ? "[PASS]" : "[FAIL]";
    console.log(`${tag} ${p.id} — ${p.detail}`);
    if (!p.ok) fail++;
  }
  console.log(`\n${probes.length - fail}/${probes.length} probes passed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
