import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchChartCandles, fetchChartHistory } from "./chartCandlesQuery";

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

describe("strict history continuation transport", () => {
  const args = { symbol: "V75", apiTf: "M1", source: "deriv_public", sourceIdentity: "a".repeat(64), before: "2026-01-01T00:00:00Z" };
  const evidence = { symbol: "V75", timeframe: "M1", source: "deriv_public", sourceIdentity: args.sourceIdentity,
    lastClosedCandleAt: "2025-12-31T23:59:00Z", scope: "public_provider" };
  function reply(historyEvidence: unknown, source = "deriv_public") {
    const fetch = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ ok: true, source, candles: [], historyEvidence }) }));
    vi.stubGlobal("fetch", fetch); return fetch;
  }
  it("sends the opaque expectation and preserves only actual matching producer evidence", async () => {
    const transport = reply(evidence);
    expect((await fetchChartHistory(args)).historyEvidence).toEqual(evidence);
    expect(String(transport.mock.calls[0]?.[0])).toContain(`sourceIdentity=${args.sourceIdentity}`);
  });
  it.each([null, { ...evidence, sourceIdentity: "b".repeat(64) }, { ...evidence, source: "mt5_broker" },
    { ...evidence, symbol: "V25" }, { ...evidence, timeframe: "M5" },
    { ...evidence, scope: "current_account" }, { ...evidence, lastClosedCandleAt: "invalid" },
    { ...evidence, lastClosedCandleAt: "2099-01-01T00:00:00Z" },
    { ...evidence, lastClosedCandleAt: "2026-01-01T00:01:00Z" },
  ])("does not turn absent/mismatched historical metadata into evidence: %s", async value => {
    reply(value); expect((await fetchChartHistory(args)).historyEvidence).toBeNull();
  });
});
