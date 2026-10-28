// Truth regression: the Market Sessions page must say the FX market is closed
// on the weekend (server `marketClosed`) and must not show any session OPEN.

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import MarketSessionsPage from "./market-sessions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Market Sessions — weekend", () => {
  it("shows the weekend close and no OPEN badge", async () => {
    const clock = {
      nowUTC: "2026-10-31T13:30:00.000Z",
      marketClosed: true,
      activeSessions: [],
      overlap: false,
      sessionLabel: "CLOSED",
      recommendation: "Interbank FX is closed for the weekend (Friday 17:00 to Sunday 17:00 New York time). No session is open.",
      sessions: [
        { id: "Sydney", isActive: false, nextOpenInHours: 33, nextCloseInHours: 42 },
        { id: "Tokyo", isActive: false, nextOpenInHours: 35, nextCloseInHours: 44 },
        { id: "London", isActive: false, nextOpenInHours: 42, nextCloseInHours: 51 },
        { id: "NewYork", isActive: false, nextOpenInHours: 48, nextCloseInHours: 57 },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => clock }) as unknown as Response));
    render(<MarketSessionsPage />);
    expect(await screen.findByTestId("sessions-weekend-closed")).toBeTruthy();
    expect(screen.queryByText("OPEN")).toBeNull();
    expect(screen.queryByText("No major session active.")).toBeNull();
  });
});

// The server now steps through the weekend close (hoursToNextTransition) and
// sends marketClosed, so its nextOpenInHours on a Saturday is the real wait to
// the Sunday reopen. The page dropped it and showed only "Closed for the
// weekend". It now shows when each session next opens, as a UTC time.
describe("Market Sessions — weekend next open", () => {
  const sessions = [
    { id: "Sydney", isActive: false, nextOpenInHours: 33, nextCloseInHours: 42 },
    { id: "Tokyo", isActive: false, nextOpenInHours: 35, nextCloseInHours: 44 },
    { id: "London", isActive: false, nextOpenInHours: 42, nextCloseInHours: 51 },
    { id: "NewYork", isActive: false, nextOpenInHours: 48, nextCloseInHours: 57 },
  ];
  const base = {
    nowUTC: "2026-10-31T13:30:00.000Z", activeSessions: [], overlap: false,
    sessionLabel: "CLOSED", recommendation: "Interbank FX is closed for the weekend.", sessions,
  };

  it("shows the server's weekend-aware next open time for each session", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ...base, marketClosed: true }) }) as unknown as Response));
    render(<MarketSessionsPage />);
    await screen.findByTestId("sessions-weekend-closed");
    // Sat 13:00 UTC hour start + 33 h = Sun 22:00 UTC.
    expect(screen.getByTestId("session-next-open-Sydney").textContent).toMatch(/Sun 22:00 UTC/);
    expect(screen.getByTestId("session-next-open-NewYork").textContent).toMatch(/Mon 13:00 UTC/);
    expect(screen.queryByText("OPEN")).toBeNull();
  });

  it("an older server (no marketClosed, hour-only times) gets no next-open time at the weekend", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ...base, sessionLabel: "QUIET" }) }) as unknown as Response));
    render(<MarketSessionsPage />);
    await screen.findByTestId("sessions-weekend-closed");
    expect(screen.queryByTestId("session-next-open-Sydney")).toBeNull();
    expect(screen.getAllByText("Closed for the weekend.").length).toBe(4);
  });
});

