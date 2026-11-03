// The chart read and the market read on the same scanner page must end their
// Risk rows with the SAME event-risk sentence (owner screenshot 2026-10-27,
// V75 1m: [F] "News/calendar unavailable — event risk not assessed." beside
// [H] "Event risk is loading…" for one truth read).
import { describe, expect, it } from "vitest";
import type { RubyMarketEdgeSignal, RubyMarketReadExplanation, ScalpResult } from "@workspace/api-client-react";
import {
  buildReasoningFromAIInsight,
  buildReasoningFromChartRead,
  buildReasoningFromMarketRead,
  buildReasoningFromScalp,
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

// Round 3 review: the scalp engine passes newsRisk "LOW" together with
// newsRiskNotConfigured (no calendar) or newsRiskUnchecked (the calendar did
// not answer). The scalp card's chip says news was not checked, but its Ruby
// Reasoning Block still wrote "Risk read — spread LOW, slippage LOW, news LOW."
describe("scalp Risk row", () => {
  const scalp = (extra: Partial<ScalpResult>) => buildReasoningFromScalp({
    result: {
      symbol: "EURUSD", direction: "BUY", status: "READY", spreadRisk: "LOW", slippageRisk: "LOW",
      newsRisk: "LOW", canBuildTrade: true, noTradeReason: null, plainEnglishReason: "Clean move.",
      ...extra,
    } as unknown as ScalpResult,
  }).evidence.risk;

  it("no calendar configured: news is 'not checked', never 'news LOW'", () => {
    const risk = scalp({ newsRiskNotConfigured: true });
    expect(risk).not.toMatch(/news\s*LOW/i);
    expect(risk).toMatch(/news not checked \(no economic calendar configured\)/);
    expect(risk).toContain(NEWS_UNAVAILABLE_NOTE);
    expect(risk).toMatch(/spread LOW, slippage LOW/);
  });

  it("calendar could not be checked: news 'could not be checked', never 'news LOW'", () => {
    const risk = scalp({ newsRiskUnchecked: true });
    expect(risk).not.toMatch(/news\s*LOW/i);
    expect(risk).toMatch(/news could not be checked/);
    expect(risk).toContain(NEWS_UNAVAILABLE_NOTE);
  });

  it("a checked calendar's LOW is reported as read", () => {
    const risk = scalp({});
    expect(risk).toMatch(/news LOW/);
    expect(risk).not.toContain(NEWS_UNAVAILABLE_NOTE);
  });

  // Review pass 2: the scalp card's News chip reads "Not checked" on
  // newsRiskNotChecked + LOW (no calendar looked at scheduled events). The
  // Ruby Reasoning Block on the same card must not say "news LOW" beside it.
  it("no calendar looked at scheduled events (newsRiskNotChecked): never 'news LOW'", () => {
    const risk = scalp({ newsRiskNotChecked: true });
    expect(risk).not.toMatch(/news\s*LOW/i);
    expect(risk).toMatch(/news not checked \(no economic calendar connected\)/);
    expect(risk).toContain(NEWS_UNAVAILABLE_NOTE);
    expect(risk).toMatch(/spread LOW, slippage LOW/);
  });

  it("newsRiskNotChecked with a MEDIUM band keeps the band, as the chip does", () => {
    const risk = scalp({ newsRiskNotChecked: true, newsRisk: "MEDIUM" });
    expect(risk).toMatch(/news MEDIUM/);
  });

  it("a failed check wins over newsRiskNotChecked (same order as the chip)", () => {
    const risk = scalp({ newsRiskNotChecked: true, newsRiskUnchecked: true });
    expect(risk).toMatch(/news could not be checked/);
    expect(risk).not.toMatch(/no economic calendar connected/);
  });
});

// Round 3 pass 3: a rejected scalp never read its spread or slippage. The
// engine's rejectResult hard-coded spreadRisk/slippageRisk "LOW", so a
// news-unchecked reject read "Risk read — spread LOW, slippage LOW, news could
// not be checked" and a SPREAD_TOO_WIDE card said "spread LOW". Reject
// fixtures here, not READY (which the engine never sends with these flags).
describe("scalp Risk row on a rejected scalp", () => {
  const reject = (extra: Partial<ScalpResult>) => buildReasoningFromScalp({
    result: {
      symbol: "EURUSD", direction: null, status: "NO_CLEAN_SCALP", spreadRisk: "LOW", slippageRisk: "LOW",
      newsRisk: "LOW", canBuildTrade: false, noTradeReason: "No clean scalp right now. Best action: wait.",
      plainEnglishReason: "No clear direction.", stopLoss: null, entryZone: null,
      ...extra,
    } as unknown as ScalpResult,
  }).evidence.risk;

  it("a reject that stopped before the spread was read (spreadNotRead) never says 'spread LOW'", () => {
    const risk = reject({ spreadNotRead: true, newsRiskUnchecked: true } as Partial<ScalpResult>);
    expect(risk).not.toMatch(/spread\s*LOW|slippage\s*LOW/i);
    expect(risk).toMatch(/spread and slippage not read/);
    expect(risk).toMatch(/news could not be checked/);
  });

  it("an older server without the flag: AWAITING_DATA / MARKET_CLOSED / SYMBOL_NOT_TRADEABLE never read the spread", () => {
    for (const status of ["AWAITING_DATA", "MARKET_CLOSED", "SYMBOL_NOT_TRADEABLE"] as const) {
      const risk = reject({ status });
      expect(risk, status).not.toMatch(/spread\s*LOW|slippage\s*LOW/i);
      expect(risk, status).toMatch(/spread and slippage not read/);
    }
  });

  it("SPREAD_TOO_WIDE says the spread was too wide, never 'spread LOW'", () => {
    const risk = reject({ status: "SPREAD_TOO_WIDE", noTradeReason: "Spread is too wide for a clean scalp right now." });
    expect(risk).not.toMatch(/spread\s*LOW/i);
    expect(risk).toMatch(/spread too wide/);
    expect(risk).not.toMatch(/slippage\s*LOW/i);
  });

  it("a news-gate reject that did read the spread keeps the band it read", () => {
    const risk = reject({ spreadRisk: "MEDIUM", slippageRisk: "MEDIUM", newsRiskUnchecked: true,
      noTradeReason: "Scheduled news risk could not be checked, so no scalp is offered right now." });
    expect(risk).toMatch(/spread MEDIUM, slippage MEDIUM, news could not be checked/);
  });
});
