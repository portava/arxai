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
