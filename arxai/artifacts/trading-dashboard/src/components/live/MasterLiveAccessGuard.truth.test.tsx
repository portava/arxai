// useMasterLiveAccess turned a failed /api/me/master-live/access read (HTTP
// error or network failure) into canTrade:false / status:null / loaded:true —
// the same verdict as a real "not approved" — so the banner said "Live trading
// requires approval." and the ticket block said "Your account is not approved
// for master live trading." for an account whose access was never checked.
// The verdict now carries `error`, and both surfaces say the access could not
// be checked. canTrade stays false (fail-closed); the server still re-checks
// access on every dispatch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { MasterLiveAccessBanner, MasterLiveAccessTicketBlock, useMasterLiveAccess } from "./MasterLiveAccessGuard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function serve(respond: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(respond));
}

describe("master live access verdict truth", () => {
  it("an HTTP error is 'could not be checked', not 'not approved'", async () => {
    serve(async () => new Response(JSON.stringify({ error: "Internal error" }), { status: 500 }));
    const { result } = renderHook(() => useMasterLiveAccess());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.canTrade).toBe(false);
    expect(result.current.status).toBeNull();
    expect(result.current.error).toMatch(/could not be checked/i);
    expect(result.current.error).toContain("500");

    render(<><MasterLiveAccessBanner /><MasterLiveAccessTicketBlock /></>);
    await screen.findByTestId("block-master-live-access-unknown");
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/Live access could not be checked/);
    expect(text).not.toMatch(/requires approval/);
    expect(text).not.toMatch(/not approved/);
  });

  it("a network failure is 'could not be checked', not 'not approved'", async () => {
    serve(async () => { throw new TypeError("Failed to fetch"); });
    render(<><MasterLiveAccessBanner /><MasterLiveAccessTicketBlock /></>);
    await screen.findByTestId("block-master-live-access-unknown");
    expect(screen.getByTestId("banner-master-live-access").textContent).toMatch(/could not be checked/);
    expect(document.body.textContent).not.toMatch(/not approved|requires approval/);
  });

  it("a real NOT_APPROVED answer still says the account is not approved", async () => {
    serve(async () => new Response(JSON.stringify({ canTrade: false, status: "NOT_APPROVED", blockReason: "NOT_APPROVED", message: null })));
    const { result } = renderHook(() => useMasterLiveAccess());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.error).toBeNull();
    render(<><MasterLiveAccessBanner /><MasterLiveAccessTicketBlock /></>);
    await screen.findByTestId("block-master-live-ticket-disabled");
    expect(document.body.textContent).toMatch(/Your account is not approved for master live trading\./);
    expect(document.body.textContent).toMatch(/Live trading requires approval\./);
  });
});
