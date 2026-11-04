/**
 * MentorHistory truth:
 *  - The page fetches only the newest N sessions (?limit=20 / ?limit=10), so
 *    group counts are counts within that window, not lifetime totals, and
 *    must say so.
 *  - The "View" button must not render when no handler is wired (it was inert).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import type { MentorSession, SessionType } from "./types";

vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Ruby", isLoading: false, isDefault: true }) }));

import { MentorHistory } from "./MentorHistory";

afterEach(() => cleanup());

function s(id: number, sessionType: SessionType): MentorSession {
  return {
    id, sessionType, skillLevel: "BEGINNER", mainFocus: `Focus ${id}`, mentorMessage: "m", recommendedAction: "a",
    relatedGoalId: null, relatedTradeId: null, relatedStrategyId: null,
    createdAt: new Date(Date.UTC(2026, 9, 28) - id * 3600_000).toISOString(),
  };
}

// Newest 20 rows of a 35-session history: 12 briefings, 5 warnings, 3 post-trade.
const page20: MentorSession[] = [
  ...Array.from({ length: 12 }, (_, i) => s(i + 1, "DAILY_BRIEFING")),
  ...Array.from({ length: 5 }, (_, i) => s(i + 13, "RISK_WARNING")),
  ...Array.from({ length: 3 }, (_, i) => s(i + 18, "POST_TRADE_GUIDANCE")),
];

describe("MentorHistory group counts", () => {
  it("labels counts as within the loaded window, not as totals", () => {
    render(<MentorHistory sessions={page20} pageLimit={20} />);
    const briefing = screen.getByTestId("conversation-group-briefing");
    expect(within(briefing).getByText(/12 briefings in your latest 20 sessions/)).toBeTruthy();
    const risk = screen.getByTestId("conversation-group-risk");
    expect(within(risk).getByText(/5 warnings in your latest 20 sessions/)).toBeTruthy();
    expect(screen.getByTestId("mentor-history-window-note").textContent).toMatch(/older sessions are not counted/i);
  });

  it("does not add the older-sessions note when fewer than the page limit came back", () => {
    render(<MentorHistory sessions={page20.slice(0, 4)} pageLimit={20} />);
    expect(screen.queryByTestId("mentor-history-window-note")).toBeNull();
  });
});

describe("MentorHistory View button", () => {
  it("is not rendered when no onSelect handler is wired", () => {
    render(<MentorHistory sessions={page20} pageLimit={20} />);
    expect(screen.queryByTestId("conversation-view-briefing")).toBeNull();
    expect(screen.queryByText("View")).toBeNull();
  });

  it("calls the handler with the latest session of the group when wired", () => {
    const onSelect = vi.fn();
    render(<MentorHistory sessions={page20} pageLimit={20} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("conversation-view-risk"));
    expect(onSelect).toHaveBeenCalledWith(page20[12]);
  });
});

describe("MentorHistory wording and dates", () => {
  it("dates each group's latest line so it is not read as current", () => {
    render(<MentorHistory sessions={page20} pageLimit={20} />);
    const briefing = screen.getByTestId("conversation-group-briefing");
    const line = within(briefing).getByTestId("conversation-latest-briefing").textContent ?? "";
    expect(line).toContain("Focus 1");
    const expected = new Date(page20[0].createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    expect(line).toContain(expected);
  });

  it("an empty history says there are no mentor sessions, not chat conversations", () => {
    render(<MentorHistory sessions={[]} pageLimit={20} />);
    expect(screen.queryByText(/conversations/i)).toBeNull();
    expect(screen.getByText(/No mentor sessions yet/)).toBeTruthy();
  });
});
