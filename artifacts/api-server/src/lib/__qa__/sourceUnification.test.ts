// THEME C1 / C2 — read paths must agree with the trade path.
//
// C1 — THE AI LIVE SCANNER READ THE WRONG FEED
//   `scoreLiveCandidates` fetched candles straight from the external provider
//   adapter (`getMarketProvider().getCandles`, i.e. TwelveData/Finnhub), while
//   the chart and the trade path read the unified `marketDataRouter`, which is
//   mt5_broker-first. The scanner therefore ranked a setup and quoted an
//   entry/SL/TP computed from a DIFFERENT feed than the one the user then saw
//   on the chart and traded against — same symbol, same moment, two answers.
//   Candles now come from `routeCandles`, so the numbers are derived from one
//   source of truth.
//
// C2 — BROAD/BUILDER HAD NO LIVE PRICE AT ALL
//   Both surfaces passed `currentPrice: o.entry` — the scanner's own entry.
//   With price and entry identical, `movedToward` is always ~0, so the
//   late/chase gate always concluded "not late". The one gate whose entire job
//   is catching a stale pick could not fire on the two surfaces most likely to
//   serve one. Focus was unaffected: it already called `currentPriceFor()`.
//
//   They now fetch a real quote per symbol through the same helper. When no
//   quote is available the value is an honest `null`, NOT a fallback to
//   `o.entry` — falling back would silently restore the bug, and the engine
//   already refuses to build a trade on a null price.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

const scanner = read("artifacts/api-server/src/lib/assistant/liveScanner.ts");
const scalpService = read("artifacts/api-server/src/lib/scalp/scalpService.ts");

/** The body of scoreLiveCandidates. */
function scanFn(): string {
  const start = scanner.indexOf("export async function scoreLiveCandidates");
  assert.ok(start > -1, "scoreLiveCandidates must still exist");
  return scanner.slice(start);
}

describe("C1 — the scanner reads the unified router", () => {
  it("imports routeCandles", () => {
    assert.ok(
      /import\s*\{[^}]*\brouteCandles\b[^}]*\}\s*from\s*"\.\.\/data\/marketDataRouter\.js"/.test(scanner),
    );
  });

  it("fetches candles through the router", () => {
    assert.ok(/await routeCandles\(sym, tf, 30\)/.test(scanFn()));
  });

  it("no longer fetches candles from the external provider adapter", () => {
    assert.ok(
      !/p\.getCandles\(/.test(scanFn()),
      "the provider adapter is a different feed than the chart and trade path use",
    );
  });

  it("still refuses on a failed or too-short router read", () => {
    const fn = scanFn();
    assert.ok(/!routed\.ok/.test(fn));
    assert.ok(/routed\.candles\.length < MIN_CANDLES/.test(fn));
  });

  it("surfaces the router's own honest message as the warning", () => {
    assert.ok(/routed\.userMessage/.test(scanFn()));
  });

  it("the shape adapter renames fields only — it derives nothing", () => {
    const adapter = scanner.slice(
      scanner.indexOf("function toScannerCandle"),
      scanner.indexOf("function clamp("),
    );
    assert.ok(/t: c\.time/.test(adapter));
    assert.ok(/o: c\.open/.test(adapter));
    assert.ok(/h: c\.high/.test(adapter));
    assert.ok(/l: c\.low/.test(adapter));
    assert.ok(/c: c\.close/.test(adapter));
    // No arithmetic beyond the documented volume default.
    assert.ok(!/[*/+-]\s*\d/.test(adapter.replace(/\?\?\s*0/g, "")));
  });
});

describe("C2 — Broad/Builder use a real live quote", () => {
  it("no longer passes the scanner entry as the live price", () => {
    assert.ok(
      !/currentPrice:\s*o\.entry/.test(scalpService),
      "price === entry makes movedToward ~0 and disables the late/chase gate",
    );
  });

  it("fetches a quote per listed symbol through the shared helper", () => {
    assert.ok(/currentPriceFor\(o\.symbol\)/.test(scalpService));
  });

  it("resolves the quotes in the same parallel batch as specs/personalities", () => {
    assert.ok(/const \[specs, personalities, livePrices\] = await Promise\.all\(/.test(scalpService));
  });

  it("passes the real price through", () => {
    assert.ok(/currentPrice:\s*livePrices\[i\]/.test(scalpService));
  });

  it("degrades to an honest null rather than falling back to the entry", () => {
    assert.ok(
      /currentPrice:\s*livePrices\[i\]\s*\?\?\s*null/.test(scalpService),
      "a fallback to o.entry would silently restore the bug",
    );
  });

  it("Focus still uses the same helper (unchanged)", () => {
    assert.ok(/currentPriceFor\(args\.symbol\)/.test(scalpService));
  });
});

describe("C2 — the engine still refuses a null price", () => {
  it("scalpEngine will not build a trade without a numeric price", async () => {
    const engine = read("artifacts/api-server/src/lib/scalp/scalpEngine.ts");
    assert.ok(
      /if \(!scanner \|\| !num\(input\.currentPrice\)\)/.test(engine),
      "the honest-null path depends on this refusal staying in place",
    );
  });
});
