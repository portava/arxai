import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChartCandles } from "./chartCandlesQuery";

afterEach(() => vi.unstubAllGlobals());

describe("chart history identity transport", () => {
  const evidence = { symbol: "V75", timeframe: "M15", source: "mt5_broker", sourceIdentity: "opaque-account-one", lastClosedCandleAt: "2026-10-26T18:00:00Z" };
  function reply(marketEvidence: unknown) {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ candles: [], feedStatus: { source: "mt5_broker" }, marketEvidence }) })));
  }
  it("preserves matching opaque evidence without deriving an account ID", async () => {
    reply(evidence);
    expect((await fetchChartCandles("V75", "M15", 200)).marketEvidence).toEqual(evidence);
  });
  it.each([
    null, { ...evidence, symbol: "V25" }, { ...evidence, timeframe: "M5" },
    { ...evidence, source: "deriv_public" }, { ...evidence, sourceIdentity: "" },
    { ...evidence, sourceIdentity: 123 },
  ])("does not invent usable evidence from absent or mismatched metadata: %s", async value => {
    reply(value);
    expect((await fetchChartCandles("V75", "M15", 200)).marketEvidence).toBeUndefined();
  });
});
