// Unit test for the broker symbol-name resolver (transport-layer name
// translation at the EA live-command boundary). Pure logic — no DB, no
// network. Verifies that ARX-internal symbol forms (uppercased display names
// and short aliases) translate to the broker's EXACT Market Watch string,
// that forex is a no-op, and that unknown symbols pass through verbatim
// (never silently re-routed to a different instrument).

import {
  buildBrokerSymbolMap,
  resolveFromMap,
  compactSymbolKey,
  findCompactKeyCollisions,
} from "../../artifacts/api-server/src/lib/mt5/brokerSymbolName.js";

type Result = { name: string; pass: boolean; detail: string };
const results: Result[] = [];
function check(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  // eslint-disable-next-line no-console
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

// Registry rows mirror the real `symbols` table truth (broker_symbol == the
// exact MT5 Market Watch name for synthetics; == symbol for forex).
const ROWS = [
  { symbol: "EURUSD", brokerSymbol: "EURUSD" },
  { symbol: "GBPUSD", brokerSymbol: "GBPUSD" },
  { symbol: "Volatility 75 Index", brokerSymbol: "Volatility 75 Index" },
  { symbol: "Volatility 75 (1s) Index", brokerSymbol: "Volatility 75 (1s) Index" },
  { symbol: "Volatility 25 (1s) Index", brokerSymbol: "Volatility 25 (1s) Index" },
];

const map = buildBrokerSymbolMap(ROWS);
const r = (s: string) => resolveFromMap(map, s);

// compact key normalization
check("compact strips case/space/paren", compactSymbolKey("Volatility 75 (1s) Index") === "VOLATILITY751SINDEX", compactSymbolKey("Volatility 75 (1s) Index"));

// forex no-op
check("EURUSD no-op", r("EURUSD") === "EURUSD", r("EURUSD"));
check("lowercase eurusd → EURUSD", r("eurusd") === "EURUSD", r("eurusd"));

// uppercased display name → exact broker case (the bug that caused EA_REJECTED_NO_DETAIL)
check("VOLATILITY 75 INDEX → exact", r("VOLATILITY 75 INDEX") === "Volatility 75 Index", r("VOLATILITY 75 INDEX"));
check("VOLATILITY 25 (1S) INDEX → exact", r("VOLATILITY 25 (1S) INDEX") === "Volatility 25 (1s) Index", r("VOLATILITY 25 (1S) INDEX"));
check("VOLATILITY 75 (1S) INDEX → exact", r("VOLATILITY 75 (1S) INDEX") === "Volatility 75 (1s) Index", r("VOLATILITY 75 (1S) INDEX"));

// already-exact passes through unchanged
check("exact name unchanged", r("Volatility 75 Index") === "Volatility 75 Index", r("Volatility 75 Index"));

// short aliases → exact broker case (resolved THROUGH the registry)
check("V75 alias → exact", r("V75") === "Volatility 75 Index", r("V75"));
check("V75(1s) alias → exact", r("V75(1s)") === "Volatility 75 (1s) Index", r("V75(1s)"));
check("V25 1s alias → exact", r("V25 1s") === "Volatility 25 (1s) Index", r("V25 1s"));

// alias whose target is NOT registered → verbatim (never invents a symbol)
check("V25 (not registered) → verbatim", r("V25") === "V25", r("V25"));
check("V50 (not registered) → verbatim", r("V50") === "V50", r("V50"));

// unknown symbol → verbatim (honest; EA reports the real broker rejection)
check("unknown → verbatim", r("XAUUSD") === "XAUUSD", r("XAUUSD"));
check("empty → verbatim", r("") === "", JSON.stringify(r("")));

// collision detector: clean registry has none; a lossy pair is flagged
check("no collisions in clean registry", findCompactKeyCollisions(ROWS).length === 0, String(findCompactKeyCollisions(ROWS).length));
const collisionRows = [
  { symbol: "Volatility 75 Index", brokerSymbol: "Volatility 75 Index" },
  { symbol: "Volatility75 Index", brokerSymbol: "VOL_75_DIFFERENT" },
];
check("collision detected for lossy pair", findCompactKeyCollisions(collisionRows).length === 1, JSON.stringify(findCompactKeyCollisions(collisionRows)));

const passed = results.filter((x) => x.pass).length;
const total = results.length;
// eslint-disable-next-line no-console
console.log(`\n${passed}/${total} PASS`);
if (passed !== total) process.exit(1);
