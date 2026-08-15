// THEME G-CUT — dead heat endpoints are gone, live ones are untouched.
//
// Three heat endpoints had zero consumers anywhere in the repo — no page, no
// hook, no service, no script:
//   GET /market-heat/countries
//   GET /market-heat/symbol/:symbol
//   GET /me/heat/snapshots/recent
//
// An unconsumed endpoint is not free: it is authenticated surface area that
// still runs a full heat build (provider fetches included) for anyone who finds
// it, and it has to be reasoned about in every future audit of this area.
//
// This suite pins BOTH directions — the three are gone AND the surfaces that
// are actually used still exist. A cut that quietly took a live route with it
// would be the expensive kind of mistake.

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

const marketHeat = read("artifacts/api-server/src/routes/marketHeat.ts");
const meHeat = read("artifacts/api-server/src/routes/meHeat.ts");
const spec = read("lib/api-spec/openapi.yaml");

describe("G-CUT — the dead heat routes are removed", () => {
  it("GET /market-heat/countries is gone", () => {
    assert.ok(!/["']\/market-heat\/countries["']/.test(marketHeat));
  });

  it("GET /market-heat/symbol/:symbol is gone", () => {
    assert.ok(!/["']\/market-heat\/symbol\/:symbol["']/.test(marketHeat));
  });

  it("GET /me/heat/snapshots/recent is gone", () => {
    assert.ok(!/["']\/me\/heat\/snapshots\/recent["']/.test(meHeat));
  });
});

describe("G-CUT — the published contract no longer advertises them", () => {
  it("openapi drops /market-heat/countries", () => {
    assert.ok(!/^ {2}\/market-heat\/countries:/m.test(spec));
  });

  it("openapi drops /market-heat/symbol/{symbol}", () => {
    assert.ok(!/^ {2}\/market-heat\/symbol\/\{symbol\}:/m.test(spec));
  });

  it("the generated client has no callers for them either", () => {
    const client = read("lib/api-client-react/src/generated/api.ts");
    assert.ok(!/market-heat\/countries/.test(client));
    assert.ok(!/market-heat\/symbol/.test(client));
  });
});

describe("G-CUT — the live heat surfaces survive", () => {
  it("GET /market-heat (the bundle the map actually uses) still exists", () => {
    assert.ok(/router\.get\(\s*["']\/market-heat["']/.test(marketHeat));
    assert.ok(/^ {2}\/market-heat:/m.test(spec), "still published in the contract");
  });

  it("GET /market-heat/diagnostics still exists", () => {
    assert.ok(/router\.get\(\s*["']\/market-heat\/diagnostics["']/.test(marketHeat));
    assert.ok(/^ {2}\/market-heat\/diagnostics:/m.test(spec));
  });

  it("the meHeat router still exports and still serves its other routes", () => {
    assert.ok(/export default router;/.test(meHeat));
    assert.ok(/router\.get\(/.test(meHeat), "meHeat must still serve routes");
  });

  it("the heat builders themselves are untouched", () => {
    // buildMarketHeat / buildHeatDiagnostics remain in use by the surviving
    // routes — the cut removed endpoints, not the engine behind them.
    assert.ok(/buildMarketHeat\(/.test(marketHeat));
    assert.ok(/buildHeatDiagnostics\(/.test(marketHeat));
  });
});
