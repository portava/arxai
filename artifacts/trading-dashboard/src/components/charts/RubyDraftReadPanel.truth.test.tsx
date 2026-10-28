// Truth: the Ruby draft-read panel must describe the read it shows.
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
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby" }) }));

import { RubyDraftReadPanel } from "./RubyDraftReadPanel";

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

describe("RubyDraftReadPanel gated banner", () => {
  it("a clean feed gated by a chart check is not called 'Feed not confirmed'", () => {
    mutation.data = read({ feedConfirmed: true });
    render(<RubyDraftReadPanel symbol="EURUSD" timeframe="M5" />);
    expect(screen.queryByTestId("ruby-draft-feed-not-confirmed")).toBeNull();
    const banner = screen.getByTestId("ruby-draft-checks-not-passed");
    expect(banner.textContent).toContain("Feed is clean for EURUSD · M5, but not every chart check passed");
    expect(banner.textContent).not.toMatch(/feed not confirmed/i);
  });

  it("an unconfirmed feed (or an older server without feedConfirmed) keeps 'Feed not confirmed'", () => {
    mutation.data = read({ feedConfirmed: false });
    render(<RubyDraftReadPanel symbol="EURUSD" timeframe="M5" />);
    expect(screen.getByTestId("ruby-draft-feed-not-confirmed").textContent).toContain("Feed not confirmed for EURUSD");
    cleanup();
    mutation.data = read({});
    render(<RubyDraftReadPanel symbol="EURUSD" timeframe="M5" />);
    expect(screen.getByTestId("ruby-draft-feed-not-confirmed")).toBeTruthy();
  });
});
