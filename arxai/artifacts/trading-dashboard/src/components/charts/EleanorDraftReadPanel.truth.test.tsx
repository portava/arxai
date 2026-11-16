// Truth: the Eleanor draft-read panel must describe the read it shows.
//  - A read gated by a chart check while the feed itself is clean must not
//    say "Feed not confirmed" (Chart Pulse beside it shows the feed clean).
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const mutation: { data: unknown; isPending: boolean; isError: boolean; mutate: ReturnType<typeof vi.fn> } = {
  data: undefined, isPending: false, isError: false, mutate: vi.fn(),
};
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePostMeAssistantDraftRead: () => mutation,
}));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Eleanor" }) }));

import { EleanorDraftReadPanel } from "./EleanorDraftReadPanel";

afterEach(() => { cleanup(); mutation.data = undefined; });

function read(over: Record<string, unknown>) {
  return {
    draftRead: {
      intent: "analyze", symbol: "EURUSD", displaySymbol: "EURUSD", timeframe: "M5",
      feedUsable: false, dataQuality: "insufficient", bias: "unknown",
      headline: "The candle feed is clean, but not every chart check passed, so I'm not giving a directional read yet.",
      points: ["Symbol Mirror Accuracy could not be measured — no usable broker-price comparison."],
      cautions: [], bestNextAction: "", confidenceLabel: "unverifiable", confidenceScore: null,
      agentConsensus: { populated: false, headline: "", stance: "neutral", conflict: false, protective: false, cautions: [] },
      disclaimer: "Decision support only.",
      ...over,
    },
    safetyMode: "paper_only", liveLocked: true, readOnlyMode: true, allowOrderExecution: false,
  };
}

describe("EleanorDraftReadPanel gated banner", () => {
  it("a clean feed gated by a chart check is not called 'Feed not confirmed'", () => {
    mutation.data = read({ feedConfirmed: true });
    render(<EleanorDraftReadPanel symbol="EURUSD" timeframe="M5" />);
    expect(screen.queryByTestId("eleanor-draft-feed-not-confirmed")).toBeNull();
    const banner = screen.getByTestId("eleanor-draft-checks-not-passed");
    expect(banner.textContent).toContain("Feed is clean for EURUSD · M5, but not every chart check passed");
    expect(banner.textContent).not.toMatch(/feed not confirmed/i);
  });

  it("an unconfirmed feed (or an older server without feedConfirmed) keeps 'Feed not confirmed'", () => {
    mutation.data = read({ feedConfirmed: false });
    render(<EleanorDraftReadPanel symbol="EURUSD" timeframe="M5" />);
    expect(screen.getByTestId("eleanor-draft-feed-not-confirmed").textContent).toContain("Feed not confirmed for EURUSD");
    cleanup();
    mutation.data = read({});
    render(<EleanorDraftReadPanel symbol="EURUSD" timeframe="M5" />);
    expect(screen.getByTestId("eleanor-draft-feed-not-confirmed")).toBeTruthy();
  });
});

describe("EleanorDraftReadPanel direction and as-of", () => {
  it("a gated read shows the direction as not read, never 'neutral'", () => {
    mutation.data = read({ bias: "unknown", confidenceLabel: "unverifiable" });
    render(<EleanorDraftReadPanel symbol="EURUSD" timeframe="M5" />);
    const label = screen.getByTestId("eleanor-draft-bias").textContent ?? "";
    expect(label).toContain("direction not read · unverifiable");
    expect(label).not.toMatch(/neutral/i);
  });

  it("an older server's gated 'neutral · unverifiable' is downgraded to not read", () => {
    mutation.data = read({ bias: "neutral", confidenceLabel: "unverifiable" });
    render(<EleanorDraftReadPanel symbol="EURUSD" timeframe="M5" />);
    expect(screen.getByTestId("eleanor-draft-bias").textContent).not.toMatch(/neutral/i);
  });

  it("a usable neutral read stays neutral", () => {
    mutation.data = read({ bias: "neutral", confidenceLabel: "B", confidenceScore: 64, dataQuality: "ok", feedUsable: true });
    render(<EleanorDraftReadPanel symbol="EURUSD" timeframe="M5" />);
    expect(screen.getByTestId("eleanor-draft-bias").textContent).toContain("neutral · B · 64/100");
  });

  it("the read says when the chart state it describes was taken, or that the time is unknown", () => {
    const asOf = "2026-10-28T11:41:07.000Z";
    mutation.data = read({ asOf });
    render(<EleanorDraftReadPanel symbol="EURUSD" timeframe="M5" />);
    expect(screen.getByTestId("eleanor-draft-as-of").textContent).toBe(
      `Chart as of ${new Date(asOf).toLocaleTimeString()} · does not update — ask again to refresh`);
    cleanup();
    mutation.data = read({});
    render(<EleanorDraftReadPanel symbol="EURUSD" timeframe="M5" />);
    expect(screen.getByTestId("eleanor-draft-as-of").textContent).toBe("Time of this read not reported");
  });
});
