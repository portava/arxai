// The chart read and the market read on the same scanner page must end their
// Risk rows with the SAME event-risk sentence (owner screenshot 2026-10-27,
// V75 1m: [F] "News/calendar unavailable — event risk not assessed." beside
// [H] "Event risk is loading…" for one truth read).
import { describe, expect, it } from "vitest";
import type { RubyMarketEdgeSignal, RubyMarketReadExplanation } from "@workspace/api-client-react";
import {
  buildReasoningFromAIInsight,
  buildReasoningFromChartRead,
  buildReasoningFromMarketRead,
  NEWS_UNAVAILABLE_NOTE,
} from "./rubyReasoningBlock";
import type { ChartRead } from "./rubyReadPanelState";
import { EVENT_RISK_NOT_ASSESSED_IN_READ, EVENT_RISK_TRUTH_UNAVAILABLE, eventRiskLine } from "./eventRiskCopy";

// [F] as the owner saw it: a structural 1m read with the delayed-feed cautions.
const ownerChartRead = {
  gated: false, dataQuality: "ok", bias: "Mixed", htfBias: "No clear edge", confidence: "Low",
  supportZone: "33250.6 – 33273.2", resistanceZone: "33639.4 – 33662.0",
  riskNote: "Edge is weak.",
  cautions: [
    "Exact entry, stop, and target levels withheld — Live feed is delayed — read uses the last confirmed bars, not the current candle.",
    "Read is from closed candles only — current-candle/entry confirmation pending.",
  ],
} as ChartRead;

function marketRead(newsRiskLabel: string | null) {
  const mode = { risk: "Risk level not published yet — wait for a defined stop before sizing." };
  return buildReasoningFromMarketRead({
    explanation: { simple: mode, advanced: mode, actionable: false, hasSufficientData: true, noTrade: { isNoTrade: true } } as unknown as RubyMarketReadExplanation,
    signal: { bias: "BULLISH", dataSource: "LIVE_FEED" } as unknown as RubyMarketEdgeSignal,
    downgraded: false,
    newsRiskLabel,
  });
}

describe("chart-read Risk row", () => {
  it("never claims the calendar provider is unavailable when the read simply did not check it", () => {
    const risk = buildReasoningFromChartRead({ read: ownerChartRead, symbol: "V75", timeframe: "1m" }).evidence.risk;
    expect(risk).toContain(EVENT_RISK_NOT_ASSESSED_IN_READ);
    expect(risk).not.toContain(NEWS_UNAVAILABLE_NOTE);
    expect(risk).not.toMatch(/unavailable/i);
  });
  it("mirrors a connected calendar's label verbatim", () => {
    const risk = buildReasoningFromChartRead({ read: ownerChartRead, symbol: "V75", timeframe: "1m", newsRiskLabel: "No scheduled events affect this symbol." }).evidence.risk;
    expect(risk).toContain("No scheduled events affect this symbol.");
    expect(risk).not.toContain(NEWS_UNAVAILABLE_NOTE);
  });
  it.each([
    ["no calendar configured", eventRiskLine({ riskLabel: "No event calendar is connected." }, "available")],
    ["calendar could not be checked", eventRiskLine({ riskLabel: "Event risk is unavailable — the economic calendar could not be checked." }, "available")],
    ["truth read withdrawn", eventRiskLine(null, "unavailable")],
    ["first fetch in flight", eventRiskLine(null, "loading")],
  ])("ends with the same sentence as the market-read Risk row: %s", (_name, line) => {
    const chart = buildReasoningFromChartRead({ read: ownerChartRead, symbol: "V75", timeframe: "1m", newsRiskLabel: line }).evidence.risk;
    const market = marketRead(line).evidence.risk;
    expect(chart.endsWith(` ${line}`)).toBe(true);
    expect(market.endsWith(` ${line}`)).toBe(true);
    if (line === EVENT_RISK_TRUTH_UNAVAILABLE) expect(chart).not.toMatch(/loading/i);
  });
});

describe("bot-review Risk row", () => {
  it("says the read carries no calendar check instead of asserting a provider outage", () => {
    const risk = buildReasoningFromAIInsight({ warning: "Size down." }).evidence.risk;
    expect(risk).toBe(`Size down. ${EVENT_RISK_NOT_ASSESSED_IN_READ}`);
  });
});
