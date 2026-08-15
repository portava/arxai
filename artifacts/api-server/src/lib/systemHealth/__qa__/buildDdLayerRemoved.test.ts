// THEME G-CUT — the Build-DD market-data READ LAYER is gone, its service stays.
//
// `routes/marketData.ts` exposed four endpoints:
//   GET  /api/market-data/quote
//   GET  /api/market-data/candles
//   GET  /api/market-data/health
//   POST /api/market-data/demo
// superseded by the live market-data router that the chart and trade paths use.
// It also advertised, in its own disclaimer, that "FALLBACK data is synthetic
// and clearly labeled" — a second, synthetic-capable read surface sitting
// beside the real one is exactly the kind of thing this fix pack is removing.
//
// CARE TAKEN — the audit called this layer "0 consumers"; that was true of the
// ROUTES but not of everything reachable through them:
//   - `systemHealth.probeDD` probed /api/market-data/health, falling back to
//     /api/data/symbols. Deleting the route alone would have made probeDD
//     report the subsystem DEGRADED while it was healthy — and the fallback
//     never existed as a route either, so it could not have covered.
//   - `qaPerfBackendSweep` measured quote/candles/health.
//   - `systemFullHealth` listed /api/market-data/health among its probe targets.
// All three are repointed here rather than left to rot.
//
// The SERVICE behind the routes (lib/marketData/marketDataService) is NOT
// deleted: paperExecutionService and paperExecutionMonitor both import
// getMarketData from it. Only the HTTP layer is removed.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../../..");

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8");
}

describe("G-CUT — the Build-DD route layer is removed", () => {
  it("routes/marketData.ts no longer exists", () => {
    assert.equal(existsSync(resolve(ROOT, "artifacts/api-server/src/routes/marketData.ts")), false);
  });

  it("it is no longer imported or mounted", () => {
    const index = read("artifacts/api-server/src/routes/index.ts");
    assert.ok(!/marketDataRouter/.test(index));
    assert.ok(!/from "\.\/marketData"/.test(index));
  });
});

describe("G-CUT — nothing is left probing the deleted endpoints", () => {
  it("systemHealth no longer HTTP-probes /api/market-data/health", () => {
    const health = read("artifacts/api-server/src/lib/systemHealth/health.ts");
    assert.ok(
      !/probeEndpoint\(\s*["']\/api\/market-data\/health["']\s*\)/.test(health),
      "probing a deleted route would report a false DEGRADED",
    );
    assert.ok(
      !/probeEndpoint\(\s*["']\/api\/data\/symbols["']\s*\)/.test(health),
      "the old fallback was never a real route either",
    );
  });

  it("probeDD calls the market-data service directly instead", () => {
    const health = read("artifacts/api-server/src/lib/systemHealth/health.ts");
    assert.ok(/marketDataHealthCheck\(\)/.test(health));
    assert.ok(/from "\.\.\/marketData\/marketDataService\.js"/.test(health));
  });

  it("probeDD degrades honestly when the real provider is down", () => {
    const health = read("artifacts/api-server/src/lib/systemHealth/health.ts");
    const fn = health.slice(health.indexOf("async function probeDD"), health.indexOf("async function probeEE"));
    assert.ok(
      /realProvider\.ok/.test(fn) && /DEGRADED/.test(fn),
      "serving from the synthetic fallback must not be reported as OK",
    );
  });

  it("the perf sweep no longer measures deleted endpoints", () => {
    const sweep = read("scripts/src/qaPerfBackendSweep.ts");
    assert.ok(!/\/api\/market-data\/quote/.test(sweep));
    assert.ok(!/\/api\/market-data\/candles/.test(sweep));
    assert.ok(!/["']\/api\/market-data\/health["']/.test(sweep));
  });

  it("systemFullHealth no longer lists the deleted health route", () => {
    const full = read("artifacts/api-server/src/routes/systemFullHealth.ts");
    assert.ok(!/["']\/api\/market-data\/health["']/.test(full));
  });
});

describe("G-CUT — the market-data SERVICE survives (paper execution needs it)", () => {
  it("the service module still exists", () => {
    assert.ok(
      existsSync(resolve(ROOT, "artifacts/api-server/src/lib/marketData/marketDataService.ts")),
      "only the HTTP layer was cut — the service has live importers",
    );
  });

  it("paper execution still imports getMarketData from it", () => {
    for (const rel of [
      "artifacts/api-server/src/lib/paperExecution/paperExecutionService.ts",
      "artifacts/api-server/src/lib/paperExecution/paperExecutionMonitor.ts",
    ]) {
      assert.ok(
        /getMarketData.*from "\.\.\/marketData\/marketDataService\.js"/s.test(read(rel)),
        `${rel} must still reach the service`,
      );
    }
  });

  it("marketDataHealthCheck is still exported", async () => {
    const mod = await import("../../marketData/marketDataService.js");
    assert.equal(typeof mod.marketDataHealthCheck, "function");
    assert.equal(typeof mod.getMarketData, "function");
  });
});

describe("G-CUT — admin/user market-data surfaces are untouched", () => {
  it("the admin diagnostics routes still exist", () => {
    const admin = read("artifacts/api-server/src/routes/adminMarketDataDiagnostics.ts");
    assert.ok(/\/admin\/market-data\/diagnostics/.test(admin));
    assert.ok(/\/admin\/market-data\/mt5-feed/.test(admin));
  });

  it("the per-user market-data status route still exists", () => {
    const me = read("artifacts/api-server/src/routes/meMarketData.ts");
    assert.ok(/\/me\/market-data\/status/.test(me));
  });
});
