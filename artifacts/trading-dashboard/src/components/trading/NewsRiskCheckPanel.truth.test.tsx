// Truth: the trade-ticket News Risk Check printed the server's riskLevel
// "none" in green and timing "quiet" even when no economic calendar answered
// (none configured, or its read failed). Nothing scheduled was looked at, so
// "none" / "quiet" were defaults, not observations. The panel now says
// scheduled news was "not checked" and shows the server's own calendar note.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

let data: Record<string, unknown> | undefined;
vi.mock("@workspace/api-client-react", () => ({
  usePostMarketNewsIntelligence: () => ({ mutate: vi.fn(), data, isError: false, isPending: false }),
}));

const { NewsRiskCheckPanel } = await import("./NewsRiskCheckPanel");

function pack(over: Record<string, unknown>, calendar: Record<string, unknown>) {
  return {
    symbol: "EURUSD", generatedAt: "2026-10-28T11:00:00Z", riskLevel: "none", bias: "unclear",
    timing: "quiet", recommendation: "watch", upcomingEvent: null, recentHeadlines: [],
    affectedCurrencies: [], safetyNote: "",
    warningSummary: "Scheduled news for EURUSD was not checked — no economic-calendar provider is connected, so upcoming events are unknown (not none).",
    dataSources: {
      headlines: { connected: false, provider: "none", count: 0 },
      calendar,
      social: { connected: false, provider: "none", note: "" },
    },
    ...over,
  };
}

const NOT_CONFIGURED = {
  connected: false, provider: "none",
  note: "No live economic-calendar provider (Trading Economics / FRED) is configured, so no scheduled events are shown.",
};

afterEach(() => { cleanup(); data = undefined; });

describe("News Risk Check — scheduled events not checked", () => {
  it("no calendar connected: reads 'not checked', never a green 'none' or 'quiet'", () => {
    data = pack({ scheduledEventRisk: "not_checked" }, NOT_CONFIGURED);
    render(<NewsRiskCheckPanel symbol="EURUSD" defaultOpen />);
    const panel = screen.getByTestId("news-risk-check-panel");
    const level = screen.getByTestId("news-risk-level");
    expect(level.textContent).toMatch(/not checked/i);
    expect(level.textContent).not.toMatch(/\bnone\b/i);
    expect(level.className).not.toContain("emerald");
    expect(screen.getByTestId("news-risk-timing").textContent).toMatch(/not checked/i);
    expect(panel.textContent).not.toMatch(/\bquiet\b/);
    expect(panel.textContent).toContain(NOT_CONFIGURED.note);
    expect(panel.textContent).not.toMatch(/relying on scheduled-event risk/i);
    expect(panel.textContent).toMatch(/no headlines were checked/i);
  });

  it("an older server without the field: a disconnected calendar is still 'not checked'", () => {
    data = pack({}, NOT_CONFIGURED);
    render(<NewsRiskCheckPanel symbol="EURUSD" defaultOpen />);
    expect(screen.getByTestId("news-risk-level").textContent).toMatch(/not checked/i);
  });

  it("control: a live calendar that answered keeps 'none' and 'quiet'", () => {
    data = pack({
      scheduledEventRisk: "checked",
      warningSummary: "No major scheduled news for EURUSD in the current window.",
    }, { connected: true, provider: "trading_economics", note: "Live economic-calendar provider connected — scheduled events are real." });
    render(<NewsRiskCheckPanel symbol="EURUSD" defaultOpen />);
    expect(screen.getByTestId("news-risk-level").textContent).toMatch(/\bnone\b/);
    expect(screen.getByTestId("news-risk-timing").textContent).toBe("quiet");
  });

  it("synthetic instrument (not applicable) keeps 'none'", () => {
    data = pack({
      symbol: "Volatility 75 Index", scheduledEventRisk: "not_applicable",
      warningSummary: "No major scheduled news for VOLATILITY 75 INDEX in the current window.",
    }, NOT_CONFIGURED);
    render(<NewsRiskCheckPanel symbol="Volatility 75 Index" defaultOpen />);
    expect(screen.getByTestId("news-risk-level").textContent).toMatch(/\bnone\b/);
  });
});
