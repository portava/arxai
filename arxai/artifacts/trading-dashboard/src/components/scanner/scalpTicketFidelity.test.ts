// THEME D1 — what the scalp ticket EXECUTES must equal what it DISPLAYS.
//
// Two mismatches between the scalp engine's output and the ticket the user
// actually submits:
//
// 1. LOT SIZE. The engine computes a real risk-based `suggestedLot` from
//    broker truth (tickValue/tickSize, clamped to minLot/maxLot/lotStep, and
//    deliberately nulled when margin is short, the flame kills the setup, or
//    the risk falls below the minimum lot). `scalpResultToSignal` dropped it,
//    so ScannerTradeModal fell back to a hardcoded 0.02 — the size that got
//    sent to the broker had no relationship to the sizing the user was shown.
//
// 2. TIMEFRAME. The ticket stamped "M1" while the engine reasons on M5
//    (SCALP_TIMEFRAME). Every downstream consumer of the ticket — journal,
//    attribution, review — recorded the wrong timeframe for the setup.
//
// A null suggestedLot must NOT silently become a number: when the engine
// refuses to size, the modal falls back to its conservative default and the
// user is not shown a size the engine declined to compute.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { scalpResultToSignal } from "@/pages/market-scanner";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../..");

function read(rel: string): string {
  return readFileSync(resolve(SRC, rel), "utf8");
}

/** Minimal ScalpResult-shaped fixture; only the fields the mapper reads. */
function scalpResult(overrides: Record<string, unknown> = {}) {
  return {
    symbol: "EURUSD",
    direction: "BUY",
    qualityScore: 72,
    plainEnglishReason: "Momentum burst with room to target.",
    riskWarning: null,
    noTradeReason: null,
    scalpType: "BREAKOUT",
    entryZone: { from: 1.1, to: 1.1004 },
    currentPrice: 1.1002,
    stopLoss: 1.0985,
    takeProfit: { main: 1.1045, quick: 1.102 },
    suggestedLot: 0.37,
    ...overrides,
  } as unknown as Parameters<typeof scalpResultToSignal>[0];
}

describe("D1 — the computed lot reaches the ticket", () => {
  it("carries suggestedLot into the signal", () => {
    expect(scalpResultToSignal(scalpResult()).suggestedLot).toBe(0.37);
  });

  it("carries a small lot unchanged (no rounding to a default)", () => {
    expect(scalpResultToSignal(scalpResult({ suggestedLot: 0.01 })).suggestedLot).toBe(0.01);
  });

  it("carries a large lot unchanged", () => {
    expect(scalpResultToSignal(scalpResult({ suggestedLot: 12.5 })).suggestedLot).toBe(12.5);
  });

  it("passes through null when the engine refused to size", () => {
    // The engine nulls suggestedLot on insufficient margin, a flame kill, or
    // below-min-lot risk. That refusal must not become a fabricated number.
    const signal = scalpResultToSignal(scalpResult({ suggestedLot: null }));
    expect(signal.suggestedLot == null).toBe(true);
  });
});

describe("D1 — the ticket's timeframe matches the engine's", () => {
  it("stamps M5, not M1", () => {
    expect(scalpResultToSignal(scalpResult()).timeframe).toBe("M5");
  });

  it("matches the engine's SCALP_TIMEFRAME constant", () => {
    const engineSrc = readFileSync(
      resolve(SRC, "../../api-server/src/lib/scalp/scalpServiceInputs.ts"),
      "utf8",
    );
    const m = /export const SCALP_TIMEFRAME = "([^"]+)"/.exec(engineSrc);
    expect(m).not.toBeNull();
    expect(scalpResultToSignal(scalpResult()).timeframe).toBe(m![1]);
  });
});

describe("D1 — the modal seeds from the signal instead of a hardcoded lot", () => {
  const modal = read("components/scanner/ScannerTradeModal.tsx");

  it("reads suggestedLot off the signal", () => {
    expect(modal).toMatch(/signal\.suggestedLot/);
  });

  it("keeps the conservative default only as a fallback", () => {
    // 0.02 may remain — but only behind a nullish fallback, never as the
    // unconditional initial value it used to be.
    const unconditional = /useState<number>\(\s*0\.02\s*\)/.test(modal);
    expect(unconditional).toBe(false);
    expect(modal).toMatch(/0\.02/);
  });

  it("re-seeds on reopen rather than pinning the first signal's lot", () => {
    // The modal resets its state whenever it opens for a new signal; the lot
    // must participate in that reset or a second setup inherits the first's size.
    const resetBlock = modal.slice(modal.indexOf("if (!open) return;"));
    expect(resetBlock).toMatch(/setLotSize\(/);
    expect(resetBlock).toMatch(/signal\.suggestedLot/);
  });
});

describe("D1 — SignalContext carries the field", () => {
  it("declares suggestedLot", () => {
    const ctx = read("components/scanner/RubySetupReason.tsx");
    const type = ctx.slice(ctx.indexOf("export type SignalContext"), ctx.indexOf("export type SetupReason"));
    expect(type).toMatch(/suggestedLot\?: number \| null;/);
  });
});
