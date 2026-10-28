import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The Risk Event Log reads /api/risk/events: the trader's Risk Governor
// trail, which holds paper, demo and live decisions alike. Each row says
// the venue the server recorded for it, or that the venue was not recorded.

const { default: RiskEvents } = await import("./risk-events");

type Ev = Record<string, unknown>;
const ev = (over: Ev = {}): Ev => ({
  eventId: "ure_1", ts: new Date().toISOString(), rule: "blocked_trade", severity: "BLOCK", decision: "block",
  explanation: "Daily loss limit reached.", ...over,
});

function serve(body: unknown, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Risk Event Log — venue", () => {
  it("does not label the whole log SIMULATOR; each row shows its own recorded venue", async () => {
    serve({ events: [
      ev({ eventId: "ure_1", environment: "LIVE", explanation: "Live order blocked." }),
      ev({ eventId: "ure_2", explanation: "Cooldown after loss." }),
    ] });
    render(<RiskEvents />);
    await screen.findByText("Live order blocked.");
    expect(screen.queryByText("SIMULATOR")).toBeNull();
    expect(screen.getByText("LIVE")).toBeTruthy();
    expect(screen.getByText(/venue not recorded/i)).toBeTruthy();
  });
});
