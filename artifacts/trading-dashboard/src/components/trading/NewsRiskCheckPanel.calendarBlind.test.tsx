// CONFIDENT_ABSENT — with the economic-calendar provider disconnected, the
// pre-trade News Risk Check panel used to show a green "· none" badge and the
// backend sentence "No major scheduled news…" — asserting quiet while the
// system was blind (a real high-impact event could be minutes away).
//
// Contract locked here:
//   1. calendar disconnected + riskLevel "none" → collapsed header reads a
//      muted "unknown" + "(calendar feed unavailable)", never a green "none".
//   2. the expanded body carries an amber blind-calendar warning.
//   3. calendar connected + "none" keeps the genuine green quiet read.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { NewsIntelligencePack } from "@workspace/api-client-react";

const mutateMock = vi.fn();
let mockData: NewsIntelligencePack | undefined;

vi.mock("@workspace/api-client-react", () => ({
  usePostMarketNewsIntelligence: () => ({
    mutate: mutateMock,
    data: mockData,
    isError: false,
    isPending: false,
  }),
}));

import { NewsRiskCheckPanel } from "./NewsRiskCheckPanel";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockData = undefined;
});

function pack(overrides: Partial<NewsIntelligencePack> = {}): NewsIntelligencePack {
  return {
    symbol: "EURUSD",
    generatedAt: new Date().toISOString(),
    riskLevel: "none",
    bias: "unclear",
    timing: "quiet",
    warningSummary:
      "Economic-calendar feed unavailable — scheduled-news risk for EURUSD is unknown, not confirmed quiet.",
    recommendation: "watch",
    upcomingEvent: null,
    recentHeadlines: [],
    affectedCurrencies: [],
    dataSources: {
      headlines: { connected: false, provider: "none", count: 0 },
      calendar: {
        connected: false,
        provider: "none",
        note: "No live economic-calendar provider (Trading Economics / FRED) is configured, so no scheduled events are shown.",
      },
      social: { connected: false, provider: "none", note: "" },
    },
    safetyNote: "",
    ...overrides,
  } as NewsIntelligencePack;
}

describe("NewsRiskCheckPanel — a blind calendar must never read as green 'none'", () => {
  it("collapsed header reads muted 'unknown', not 'none', when the calendar is disconnected", () => {
    mockData = pack();
    render(<NewsRiskCheckPanel symbol="EURUSD" />);

    const badge = screen.getByTestId("news-risk-level-badge");
    expect(badge.textContent ?? "").toMatch(/unknown/i);
    expect(badge.textContent ?? "").not.toMatch(/none/i);
    expect(badge.className).toContain("text-txt-muted");
    expect(badge.className).not.toContain("text-success");
    expect(screen.getByText(/\(calendar feed unavailable\)/i)).toBeTruthy();
  });

  it("expanded body shows the amber blind-calendar warning", () => {
    mockData = pack();
    render(<NewsRiskCheckPanel symbol="EURUSD" defaultOpen />);

    const warn = screen.getByTestId("news-risk-calendar-blind");
    expect(warn.textContent ?? "").toMatch(/scheduled-event risk is unknown/i);
    expect(warn.className).toContain("text-warning");
  });

  it("calendar connected + 'none' keeps the genuine green quiet read", () => {
    mockData = pack({
      warningSummary: "No major scheduled news for EURUSD in the current window.",
      dataSources: {
        headlines: { connected: true, provider: "finnhub", count: 0 },
        calendar: {
          connected: true,
          provider: "tradingeconomics",
          note: "Live economic-calendar provider connected — scheduled events are real.",
        },
        social: { connected: false, provider: "none", note: "" },
      },
    } as Partial<NewsIntelligencePack>);
    render(<NewsRiskCheckPanel symbol="EURUSD" defaultOpen />);

    const badge = screen.getByTestId("news-risk-level-badge");
    expect(badge.textContent ?? "").toMatch(/none/i);
    expect(badge.className).toContain("text-success");
    expect(screen.queryByTestId("news-risk-calendar-blind")).toBeNull();
  });

  it("the collapsed→expanded toggle still works with the blind badge in place", () => {
    mockData = pack();
    render(<NewsRiskCheckPanel symbol="EURUSD" />);

    expect(screen.queryByTestId("news-risk-calendar-blind")).toBeNull();
    fireEvent.click(screen.getByText(/News Risk Check/i));
    expect(screen.getByTestId("news-risk-calendar-blind")).toBeTruthy();
  });
});
