// Regression: the Positions page "Future MT5 Broker" tab said "This panel
// activates once the bridge is connected", but the page has no broker data
// path — the tab can never show broker positions, connected or not.
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const { default: PositionsPage } = await import("./positions");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Positions MT5 tab copy", () => {
  it("does not promise the panel activates when the bridge connects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ positions: [] }), { status: 200 })));
    render(<PositionsPage />);
    fireEvent.click(screen.getByRole("button", { name: /MT5 Broker/ }));
    const panel = screen.getByTestId("positions-mt5-panel");
    expect(panel.textContent).not.toMatch(/activates once the bridge is connected/);
    expect(panel.textContent).toMatch(/does not read broker positions/);
    expect(screen.getByRole("link", { name: /Open Trades/ }).getAttribute("href")).toMatch(/\/my-trades$/);
  });
});
