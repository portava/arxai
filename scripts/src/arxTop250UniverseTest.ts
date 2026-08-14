// Task #412 — ARX Top 250 approved market universe tests.
//
// Pure logic — no DB, no network. Verifies the canonical directory, the
// provider-intersection choke point, availability gating (selectable only on
// real data; simulator-only never selectable), the Ruby alias/nickname
// resolver (gated to the approved Top 250), and user-safe copy.

import {
  ARX_TOP_250,
  ARX_MARKET_COPY,
  FORBIDDEN_USER_MARKET_TOKENS,
  resolveUserMarketInput,
  findMarketByStandardSymbol,
  isApprovedStandardSymbol,
  intersectProviderSymbols,
  getUserVisibleMarkets,
  availabilityFromDataStatus,
} from "@workspace/markets";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

// ── Directory integrity ─────────────────────────────────────────────────────
check("exactly 250 approved markets", ARX_TOP_250.length === 250, `count=${ARX_TOP_250.length}`);
check(
  "ranks are sequential 1..250",
  ARX_TOP_250.every((m, i) => m.rank === i + 1),
  "rank order",
);
check(
  "every market approved=true",
  ARX_TOP_250.every((m) => m.approved === true),
  "approved flag",
);
{
  const ids = new Set<string>();
  const stds = new Set<string>();
  let dupId = 0;
  let dupStd = 0;
  for (const m of ARX_TOP_250) {
    if (ids.has(m.id)) dupId++;
    ids.add(m.id);
    const su = m.standardSymbol.toUpperCase();
    if (stds.has(su)) dupStd++;
    stds.add(su);
  }
  check("no duplicate ids", dupId === 0, `dupId=${dupId}`);
  check("no duplicate standard symbols", dupStd === 0, `dupStd=${dupStd}`);
}
{
  // Spec group counts.
  const counts: Record<string, number> = {};
  for (const m of ARX_TOP_250) counts[m.assetClass] = (counts[m.assetClass] ?? 0) + 1;
  const want = {
    forex_major: 7, forex_cross: 21, forex_exotic: 27, metal: 10, energy: 7,
    index: 18, stock: 80, etf: 20, crypto: 30, synthetic: 24, commodity: 6,
  };
  const ok = Object.entries(want).every(([k, v]) => counts[k] === v);
  check("asset-class group counts match spec", ok, JSON.stringify(counts));
}

// ── Case: user list contains only Top 250 ───────────────────────────────────
{
  const visible = getUserVisibleMarkets();
  const allApproved = visible.every((v) => v.market.approved === true);
  check("getUserVisibleMarkets returns only approved Top 250", visible.length === 250 && allApproved, `len=${visible.length}`);
}

// ── Case: raw broker symbols outside Top 250 filtered out (intersection) ─────
{
  const discovered = ["EUR/USD", "R_75", "FOOBAR", "TEST_SYMBOL", "DEV_FAKE", "BTCUSDT"];
  const kept = intersectProviderSymbols(discovered).map((m) => m.standardSymbol);
  const onlyApproved = kept.every((s) => isApprovedStandardSymbol(s));
  const droppedJunk = !kept.includes("FOOBAR") && !kept.includes("TEST_SYMBOL") && !kept.includes("DEV_FAKE");
  check(
    "intersectProviderSymbols keeps approved + drops junk",
    onlyApproved && droppedJunk && kept.includes("EURUSD") && kept.includes("Volatility 75 Index") && kept.includes("BTCUSD"),
    JSON.stringify(kept),
  );
}

// ── Case: availability gating ───────────────────────────────────────────────
{
  const m = findMarketByStandardSymbol("EURUSD")!;
  const noData = availabilityFromDataStatus(m, "no_data");
  check("no-data market NOT selectable", noData.selectable === false && noData.tradeable === false, noData.disabledReason ?? "");
  check("no-data disabledReason = approved-no-data copy", noData.disabledReason === ARX_MARKET_COPY.approvedNoData, noData.disabledReason ?? "");

  const sim = availabilityFromDataStatus(m, "simulator_only");
  check("simulator-only market NOT selectable", sim.selectable === false && sim.tradeable === false, sim.dataStatus);

  const provMissing = availabilityFromDataStatus(m, "provider_missing");
  check("provider_missing NOT selectable", provMissing.selectable === false, provMissing.dataStatus);

  const brokerMissing = availabilityFromDataStatus(m, "broker_mapping_missing");
  check("broker_mapping_missing NOT selectable + broker copy", brokerMissing.selectable === false && brokerMissing.disabledReason === ARX_MARKET_COPY.brokerNotConfirmed, brokerMissing.disabledReason ?? "");

  const live = availabilityFromDataStatus(m, "live", { brokerMapped: false });
  check("real-data market IS selectable", live.selectable === true, live.dataStatus);
  check("real-data but no broker mapping = analysis-only (not tradeable)", live.tradeable === false && live.disabledReason === ARX_MARKET_COPY.brokerNotConfirmed, live.disabledReason ?? "");

  const tradeable = availabilityFromDataStatus(m, "live", { brokerMapped: true, tradeable: true });
  check("broker-mapped + gates-pass market IS tradeable", tradeable.tradeable === true && tradeable.disabledReason === null, "tradeable");

  const delayed = availabilityFromDataStatus(m, "delayed");
  check("delayed real data IS selectable", delayed.selectable === true, delayed.dataStatus);
}

// ── Case: Ruby alias/nickname resolution gated to Top 250 ───────────────────
function rsym(input: string): string | null {
  const r = resolveUserMarketInput(input);
  return r.status === "resolved" ? r.market!.standardSymbol : null;
}
check("gold → XAUUSD", rsym("gold") === "XAUUSD", String(rsym("gold")));
check("nasdaq → US100", rsym("nasdaq") === "US100", String(rsym("nasdaq")));
check("nas100 → US100", rsym("nas100") === "US100", String(rsym("nas100")));
check("ustec → US100", rsym("ustec") === "US100", String(rsym("ustec")));
check("dow → US30", rsym("dow") === "US30", String(rsym("dow")));
check("spx → US500", rsym("spx") === "US500", String(rsym("spx")));
check("s&p → US500", rsym("s&p") === "US500", String(rsym("s&p")));
check("sp500 → US500", rsym("sp500") === "US500", String(rsym("sp500")));
check("bitcoin → BTCUSD", rsym("bitcoin") === "BTCUSD", String(rsym("bitcoin")));
check("btc → BTCUSD", rsym("btc") === "BTCUSD", String(rsym("btc")));
check("eth → ETHUSD", rsym("eth") === "ETHUSD", String(rsym("eth")));
check("v75 → Volatility 75 Index", rsym("v75") === "Volatility 75 Index", String(rsym("v75")));
check("vol 75 → Volatility 75 Index", rsym("vol 75") === "Volatility 75 Index", String(rsym("vol 75")));
check("volatility 75 → Volatility 75 Index", rsym("volatility 75") === "Volatility 75 Index", String(rsym("volatility 75")));
check("v75 1s → Volatility 75 1s Index", rsym("v75 1s") === "Volatility 75 1s Index", String(rsym("v75 1s")));
check("boom 1000 → Boom 1000 Index", rsym("boom 1000") === "Boom 1000 Index", String(rsym("boom 1000")));
check("EUR/USD (separators) → EURUSD", rsym("EUR/USD") === "EURUSD", String(rsym("EUR/USD")));
check("apple → AAPL", rsym("apple") === "AAPL", String(rsym("apple")));
check("full synthetic name resolves (display)", rsym("Volatility 75 Index") === "Volatility 75 Index", String(rsym("Volatility 75 Index")));

// ── Case: Ruby ambiguity (oil → clarify) ────────────────────────────────────
{
  const r = resolveUserMarketInput("oil");
  const candidates = r.candidates.map((c) => c.standardSymbol);
  check("oil → ambiguous clarify", r.status === "ambiguous" && candidates.length >= 2, JSON.stringify(candidates));
}

// ── Case: Ruby rejects outside Top 250 ──────────────────────────────────────
{
  const r = resolveUserMarketInput("dogwifhat moon coin");
  check("outside Top 250 → not_in_universe", r.status === "not_in_universe", r.status);
}

// ── Case: user-safe copy never leaks internal tokens ────────────────────────
{
  const blob = JSON.stringify(ARX_MARKET_COPY).toLowerCase();
  const leaked = FORBIDDEN_USER_MARKET_TOKENS.filter((t) => blob.includes(t.toLowerCase()));
  check("user copy leaks no internal tokens", leaked.length === 0, leaked.join(",") || "clean");
}

// ── Case: admin diagnostics still have raw provider/broker symbols ──────────
{
  const v75 = findMarketByStandardSymbol("Volatility 75 Index")!;
  const hasRaw = v75.providerSymbols.some((p) => /R_75|1HZ75V|V75/i.test(p));
  check("admin-visible raw provider symbols retained on market", hasRaw, JSON.stringify(v75.providerSymbols));
}

// ── Summary ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
// eslint-disable-next-line no-console
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`FAILED: ${failed.map((f) => f.name).join("; ")}`);
  process.exit(1);
}
