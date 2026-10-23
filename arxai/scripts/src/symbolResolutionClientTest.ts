// T033 Phase 6B — frontend symbol-resolution contract test.
//
// Proves the client resolution behavior the trade ticket relies on:
//   - exact match → use brokerSymbol
//   - ambiguous → expose candidates (force user choice, block submit)
//   - not found → block (no EURUSD/default fallback)
//   - empty input → not found
//   - the findSymbol helper matches on key/broker/display
//
// resolveBrokerSymbol() does a real fetch, so we stub global.fetch to assert
// the client maps each backend response shape correctly without a server.

import { resolveBrokerSymbol, findSymbol, type Mt5SymbolView } from "../../artifacts/trading-dashboard/src/lib/useMt5Symbols.js";

type CheckResult = { id: number; name: string; ok: boolean; detail: string };
const results: CheckResult[] = [];
function record(id: number, name: string, ok: boolean, detail: string) {
  results.push({ id, name, ok, detail });
}

// Minimal fetch stub.
function stubFetch(jsonBody: unknown, okStatus = true) {
  (globalThis as { fetch?: unknown }).fetch = async () => ({
    ok: okStatus,
    json: async () => jsonBody,
  });
}

function mkSym(symbol: string, broker: string, display?: string): Mt5SymbolView {
  return {
    symbol, brokerSymbol: broker, displaySymbol: display ?? broker, category: null,
    tradable: true, reasonNotTradable: null, bid: null, ask: null, spreadPoints: null,
    digits: null, point: null, tickSize: null, tickValue: null, contractSize: null,
    minLot: null, maxLot: null, lotStep: null, tradeMode: null, fillingModes: null,
    orderModes: null, stopsLevel: null, freezeLevel: null, marginCurrency: null,
    profitCurrency: null, lastTickTime: null, selectResult: null, freshness: "FRESH",
    snapshotAt: null, lastSeenAt: null,
  };
}

async function run() {
  // 1. exact match → brokerSymbol
  stubFetch({ ok: true, resolution: { ok: true, brokerSymbol: "Volatility 75 Index", matched: mkSym("V75", "Volatility 75 Index") } });
  const r1 = await resolveBrokerSymbol("V75");
  record(1, "exact match returns brokerSymbol", r1.ok && r1.brokerSymbol === "Volatility 75 Index", JSON.stringify(r1));

  // 2. ambiguous → candidates, ok:false
  stubFetch({ ok: false, reasonCode: "SYMBOL_AMBIGUOUS", candidates: [mkSym("V75", "Volatility 75 Index"), mkSym("V75_1S", "Volatility 75 (1s) Index")] });
  const r2 = await resolveBrokerSymbol("Volatility 75");
  record(2, "ambiguous → candidates, not ok",
    !r2.ok && r2.reasonCode === "SYMBOL_AMBIGUOUS" && (r2 as { candidates: unknown[] }).candidates.length === 2, JSON.stringify(r2));

  // 3. not found → ok:false, SYMBOL_NOT_FOUND (NO fallback)
  stubFetch({ ok: false, reasonCode: "SYMBOL_NOT_FOUND" });
  const r3 = await resolveBrokerSymbol("NOPE_XYZ");
  record(3, "not found → no fallback",
    !r3.ok && r3.reasonCode === "SYMBOL_NOT_FOUND" && !(r3 as { brokerSymbol?: string }).brokerSymbol, JSON.stringify(r3));

  // 4. CRITICAL: not-found never yields EURUSD
  record(4, "not-found is never EURUSD",
    !(r3 as { brokerSymbol?: string }).brokerSymbol || (r3 as { brokerSymbol?: string }).brokerSymbol !== "EURUSD",
    JSON.stringify(r3));

  // 5. empty input → SYMBOL_NOT_FOUND without even fetching
  const r5 = await resolveBrokerSymbol("   ");
  record(5, "empty input → SYMBOL_NOT_FOUND", !r5.ok && r5.reasonCode === "SYMBOL_NOT_FOUND", JSON.stringify(r5));

  // 6. network error → RESOLVE_ERROR (block, no fallback)
  (globalThis as { fetch?: unknown }).fetch = async () => { throw new Error("network"); };
  const r6 = await resolveBrokerSymbol("EURUSD");
  record(6, "network error → RESOLVE_ERROR, no fallback",
    !r6.ok && r6.reasonCode === "RESOLVE_ERROR", JSON.stringify(r6));

  // 7-9. findSymbol matches on key / broker / display
  const inv = [mkSym("V75", "Volatility 75 Index", "Volatility 75 Index"), mkSym("EURUSD", "EURUSD")];
  record(7, "findSymbol by ARX key", findSymbol(inv, "v75")?.brokerSymbol === "Volatility 75 Index", "");
  record(8, "findSymbol by broker string", findSymbol(inv, "Volatility 75 Index")?.symbol === "V75", "");
  record(9, "findSymbol unknown → null", findSymbol(inv, "ZZZ") === null, "");

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) {
    // eslint-disable-next-line no-console
    console.log(`${r.ok ? "PASS" : "FAIL"}  #${String(r.id).padStart(2, "0")}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  }
  // eslint-disable-next-line no-console
  console.log(`\n${passed}/${results.length} symbol-resolution checks passed`);
  if (passed !== results.length) process.exit(1);
}

run();
