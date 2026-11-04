/**
 * Mentor focus card truth:
 *  - The heading names the session's own cadence; a daily / pre-market /
 *    post-trade / warning session is not "Weekly Focus".
 *  - A RISK_WARNING / DISCIPLINE_CHECK session is shown in full by the
 *    warning card, so the page must not print the same message twice.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MentorSession, SessionType } from "./types";

vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby", isLoading: false, isDefault: true }) }));

import { DailyMentorBriefingCard } from "./DailyMentorBriefingCard";
import AiMentorPage from "@/pages/ai-mentor";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function session(sessionType: SessionType): MentorSession {
  return {
    id: 7, sessionType, skillLevel: "BEGINNER",
    mainFocus: "Cut size after two losses",
    mentorMessage: "You took three trades after a loss streak yesterday.",
    recommendedAction: "Halve size on the next trade.",
    relatedGoalId: null, relatedTradeId: null, relatedStrategyId: null,
    createdAt: "2026-10-28T08:00:00.000Z",
  };
}

describe("DailyMentorBriefingCard heading", () => {
  for (const t of ["DAILY_BRIEFING", "PRE_MARKET_GUIDANCE", "POST_TRADE_GUIDANCE", "RISK_WARNING", "DISCIPLINE_CHECK", "CONFIDENCE_REBUILD"] as const) {
    it(`${t} is not headed "Weekly Focus"`, () => {
      render(<DailyMentorBriefingCard session={session(t)} />);
      expect(screen.queryByRole("heading", { name: "Weekly Focus" })).toBeNull();
    });
  }
  it("WEEKLY_RESET is headed Weekly Focus", () => {
    render(<DailyMentorBriefingCard session={session("WEEKLY_RESET")} />);
    expect(screen.getByRole("heading", { name: "Weekly Focus" })).toBeTruthy();
  });
});

describe("AI Mentor page shows a warning session once", () => {
  it("prints the RISK_WARNING mentorMessage a single time", async () => {
    const s = session("RISK_WARNING");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = String(url).includes("/latest") ? { session: s, actionItems: [] } : { sessions: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={qc}><AiMentorPage /></QueryClientProvider>);
    await screen.findAllByText(s.mainFocus);
    expect(screen.getAllByText(s.mentorMessage)).toHaveLength(1);
    expect(screen.getAllByText(s.mainFocus)).toHaveLength(1);
    // The next action is not in the warning card, so it still renders.
    expect(screen.getByText(s.recommendedAction)).toBeTruthy();
  });
});
