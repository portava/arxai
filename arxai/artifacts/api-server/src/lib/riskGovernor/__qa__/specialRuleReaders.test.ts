// Risk Control Center special-rule truth guard. The dashboard's Rules tab says
// "V75 reduced lot" and "Spike protection" are saved but not applied, because
// risk_settings.vol75_small_lot and disable_during_abnormal_volatility are
// passed through to GET /risk/settings and read by nothing else: the position
// sizer does not halve a V75 lot for the toggle, and no check pauses trading.
// This guard fails the moment a server module starts reading either field, so
// the page copy is revisited together with the new reader.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import { calculatePositionSize } from "../positionSizer.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "__qa__" || name === "__tests__") continue;
      walk(full, out);
    } else if (/\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.|\.spec\./.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
}

const PASS_THROUGH = ["lib/risk/userRiskSettings.ts"];

describe("saved-only special rules have no reader", () => {
  const files = walk(SRC);

  it("scans a real source tree", () => {
    assert.ok(files.some((f) => f.endsWith("lib/risk/userRiskSettings.ts")), "userRiskSettings.ts not found");
  });

  for (const field of ["vol75SmallLot", "disableDuringAbnormalVolatility"]) {
    it(`${field} is only passed through to GET /risk/settings`, () => {
      const users = files
        .filter((f) => new RegExp(`\\b${field}\\b`).test(stripComments(readFileSync(f, "utf8"))))
        .map((f) => relative(SRC, f).split("\\").join("/"));
      assert.deepEqual(users, PASS_THROUGH);
    });
  }

  it("no module reads either column by raw SQL", () => {
    const users = files
      .filter((f) => /\b(vol75_small_lot|disable_during_abnormal_volatility)\b/.test(stripComments(readFileSync(f, "utf8"))))
      .map((f) => relative(SRC, f));
    assert.deepEqual(users, []);
  });
});

describe("the position sizer, as the Rules tab describes it", () => {
  const base = { accountBalance: 1000, riskPercent: 1, entry: 100, stopLoss: 90 };

  it("does not halve a Volatility 75 Index lot (no toggle reaches it)", () => {
    const v75 = calculatePositionSize({ ...base, symbol: "Volatility 75 Index" });
    const other = calculatePositionSize({ ...base, symbol: "Volatility 25 Index" });
    assert.equal(v75.finalLot, 1);
    assert.equal(v75.finalLot, other.finalLot);
  });

  it("halves any symbol whose name contains \"1s\", with no toggle input", () => {
    const oneSecond = calculatePositionSize({ ...base, symbol: "Volatility 75 (1s) Index" });
    assert.equal(oneSecond.finalLot, 0.5);
    assert.match(oneSecond.warning ?? "", /halved/);
  });
});
