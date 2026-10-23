// THEME C3.2 — the forming tip must be appended for any live provider.
//
// C3.1 gave the composer a real non-broker tick source. This locks the second
// half: chartDataService only appended the tip when `source === "mt5_broker"`,
// so even with Deriv ticks folding, a Deriv-fed chart still received no tip and
// still froze between closed candles.
//
// The gate that matters is "is there a REAL tick for this symbol's current
// interval", which `getFormingBar` already answers — not "which provider won
// the candle race". A symbol with no folded ticks still gets no tip, because
// the composer has nothing to give.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVICE = resolve(HERE, "../chartDataService.ts");

function serviceSource(): string {
  return readFileSync(SERVICE, "utf8");
}

/** The forming-tip block, from its opening guard to the quality precedence. */
function formingTipBlock(src: string): string {
  const start = src.indexOf("if (includeFormingTip");
  assert.ok(start > -1, "the forming-tip guard must still exist");
  const end = src.indexOf("Quality precedence", start);
  assert.ok(end > start, "the forming-tip block must precede the quality verdict");
  return src.slice(start, end);
}

describe("C3.2 — the append gate is not provider-scoped", () => {
  it("does not require source === 'mt5_broker' to append a tip", () => {
    const block = formingTipBlock(serviceSource());
    assert.ok(
      !/source\s*===\s*["']mt5_broker["']/.test(block),
      "a broker-only append gate freezes every Deriv-fed chart between closed candles",
    );
  });

  it("still gates on an opt-in request and a real newest bar", () => {
    const block = formingTipBlock(serviceSource());
    assert.ok(/includeFormingTip/.test(block), "the tip must remain OPT-IN for display routes");
    assert.ok(/lastCandle/.test(block), "a tip needs a newest closed bar to sit against");
  });

  it("still sources the tip from the composer, never synthesizing one", () => {
    const block = formingTipBlock(serviceSource());
    assert.ok(
      /getFormingBar\(/.test(block),
      "the tip must come from real folded ticks — the composer is the only source",
    );
    assert.ok(
      /getFormingTickAgeMs\(/.test(block),
      "the honest tick age must still drive the downstream freshness verdict",
    );
  });

  it("keeps the stale-tip guard that ignores a tip behind the closed feed", () => {
    const block = formingTipBlock(serviceSource());
    assert.ok(
      /tipOpenMs\s*>\s*lastClosedOpenMs/.test(block),
      "a tip for an interval ahead of the newest closed bar is appended",
    );
    assert.ok(
      /tipOpenMs\s*===\s*lastClosedOpenMs/.test(block),
      "a tip for the SAME interval merges onto the closed bar",
    );
  });

  it("marks the appended tip as forming, never as a complete provider bar", () => {
    const block = formingTipBlock(serviceSource());
    assert.ok(/isComplete:\s*false/.test(block));
    assert.ok(/isFinal:\s*false/.test(block));
    assert.ok(/isForming:\s*true/.test(block));
    assert.ok(/FORMING_BAR/.test(block), "the tip must carry the FORMING_BAR quality flag");
  });
});

describe("C3.2 — the composer's own contract is unchanged", () => {
  it("a symbol with no folded ticks yields no tip", async () => {
    const { getFormingBar, __resetFormingBarStore } = await import("../formingBarComposer.js");
    __resetFormingBarStore();
    assert.equal(
      getFormingBar("EURUSD", "M1", Date.now()),
      null,
      "relaxing the source gate must not conjure a tip where no tick exists",
    );
  });

  it("a tick from any provider produces a tip for that symbol", async () => {
    const { foldFormingTick, getFormingBar, __resetFormingBarStore } = await import(
      "../formingBarComposer.js"
    );
    __resetFormingBarStore();
    const now = Date.now();
    foldFormingTick("R_75", 1500, now, now);
    assert.ok(getFormingBar("V75", "M1", now), "a Deriv-sourced tick yields a real tip");
  });
});
