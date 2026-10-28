// One event-risk sentence across the scanner page (owner screenshot 2026-10-27,
// V75 1m: the NEWS block said "Event risk is loading…" while the Risk row beside
// it said "News/calendar unavailable — event risk not assessed." for the SAME
// withdrawn truth read, and the chart's Economic-events layer said nothing).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVENT_RISK_CHECKING,
  EVENT_RISK_TRUTH_UNAVAILABLE,
  eventRiskLine,
} from "./eventRiskCopy";

const src = (rel: string) => readFileSync(resolve(__dirname, rel), "utf8");

describe("eventRiskLine", () => {
  it("mirrors the server calendar label verbatim when the truth read carries it", () => {
    expect(eventRiskLine({ riskLabel: "No event calendar is connected." }, "available")).toBe("No event calendar is connected.");
    expect(eventRiskLine({ riskLabel: "Event risk is unavailable — the economic calendar could not be checked." }, "available"))
      .toBe("Event risk is unavailable — the economic calendar could not be checked.");
  });
  it("says 'checking' only while the first fetch is in flight", () => {
    expect(eventRiskLine(null, "loading")).toBe(EVENT_RISK_CHECKING);
  });
  it("a withdrawn / failed / disabled read is 'not checked', never loading", () => {
    for (const state of ["unavailable", undefined, null] as const) {
      const line = eventRiskLine(null, state);
      expect(line).toBe(EVENT_RISK_TRUTH_UNAVAILABLE);
      expect(line).not.toMatch(/loading|checking/i);
    }
  });
  it("a blank server label is not a calendar state", () => {
    expect(eventRiskLine({ riskLabel: "  " }, "available")).toBe(EVENT_RISK_TRUTH_UNAVAILABLE);
  });
});

describe("every scanner surface prints the same event-risk sentence", () => {
  it("the market-read card prints eventRiskLine in its News block and passes the same line to its Risk row", () => {
    const card = src("../components/scanner/RubyMarketReadCard.tsx");
    expect(card).not.toContain("Event risk is loading");
    expect(card).toMatch(/const eventRisk = eventRiskLine\(news, newsState\)/);
    expect(card).toMatch(/newsRiskLabel: eventRisk,/);
    expect(card).toMatch(/data-testid="ruby-market-read-news"[\s\S]{0,400}\{eventRisk\}/);
  });
  it("the chart's Economic-events layer is never silent when the truth read has no news", () => {
    const panel = src("../components/scanner/ScannerChartPanel.tsx");
    expect(panel).toMatch(/const eventRisk = eventRiskLine\(news, newsState\)/);
    expect(panel).toMatch(/\{layerToggles\.news && !news && \([\s\S]{0,600}data-testid="scanner-news-radar-status">\{eventRisk\}/);
  });
});
