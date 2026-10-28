// OpenDemoPositions: when the server reports positionsMeasured false (null
// counts, inSync null) the header read "· 0 open · null orphan" and the body
// "No open demo positions". Unread positions are now "not checked".
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OpenDemoPositions, openDemoPositionsSummary } from "./OpenDemoPositions";

const NOTE = "Your MT5 account state could not be attributed to you.";
const UNREAD = {
  ok: true, safetyMode: "demo_only", liveExecutionBlocked: true, lastSyncAt: null,
  positionsMeasured: false, positionsNote: NOTE, openPositions: [],
  reconciliation: { mt5OpenPositionCount: null, arxMatchedPositionCount: null, arxOrphanPositionCount: null, filledCommandHistoryCount: 2, inSync: null },
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("OpenDemoPositions", () => {
  it("summary: unread positions are 'not checked', never '0 open · null orphan'", () => {
    expect(openDemoPositionsSummary(UNREAD)).toBe("positions not checked");
    expect(openDemoPositionsSummary({ ...UNREAD, positionsMeasured: undefined })).toBe("0 open · sync not checked");
    expect(openDemoPositionsSummary({
      ...UNREAD, positionsMeasured: true,
      reconciliation: { ...UNREAD.reconciliation, arxOrphanPositionCount: 0, inSync: true },
    })).toBe("0 open · in sync");
  });

  it("an unread book shows the reason, not 'No open demo positions'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(UNREAD), { status: 200 })));
    render(<OpenDemoPositions />);
    const el = await screen.findByTestId("open-demo-positions-not-measured");
    expect(el.textContent).toContain(NOTE);
    expect(document.body.textContent).not.toMatch(/No open demo positions/);
    expect(document.body.textContent).not.toMatch(/null orphan/);
    expect(document.body.textContent).toMatch(/positions not checked/);
  });
});
