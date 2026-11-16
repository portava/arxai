import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The Session Report page used to collapse every failed read or refused
// generate into "No report yet — pick a session and generate.", although a
// report may exist (GET answered 500) or generation was refused (POST 403 from
// the paper_trade:create permission check in paperSessions.ts).

const { default: SessionReport } = await import("./session-report");

type Reply = { status: number; body: unknown };
function stubRoutes(routes: { list: Reply; get: Reply; post?: Reply }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string }) => {
    const pick = url.startsWith("/api/paper-sessions?") ? routes.list
      : init?.method === "POST" ? (routes.post ?? { status: 500, body: {} })
      : routes.get;
    return { ok: pick.status >= 200 && pick.status < 300, status: pick.status, json: async () => pick.body };
  }));
}

const sessions = { status: 200, body: { sessions: [{ paper_session_id: "ps_1", status: "ENDED" }] } };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Session Report — failures are not 'No report yet'", () => {
  it("a 500 on the report read says the report could not be loaded", async () => {
    stubRoutes({ list: sessions, get: { status: 500, body: { error: "db down" } } });
    render(<SessionReport />);
    expect(await screen.findByText(/Could not load the report/)).toBeTruthy();
    expect(screen.queryByText(/No report yet/)).toBeNull();
  });

  it("a refused generate shows the refusal, not 'No report yet'", async () => {
    stubRoutes({
      list: sessions,
      get: { status: 404, body: { error: "no report yet — POST /:id/report to generate" } },
      post: { status: 403, body: { result: { status: "REJECTED", reason: "role VIEWER lacks paper_trade:create" } } },
    });
    render(<SessionReport />);
    expect(await screen.findByText(/No report yet/)).toBeTruthy();
    fireEvent.click(screen.getByText("Generate report"));
    await waitFor(() => expect(screen.getByText(/Report was not generated/)).toBeTruthy());
    expect(screen.getByText(/role VIEWER lacks paper_trade:create/)).toBeTruthy();
    expect(screen.queryByText(/No report yet/)).toBeNull();
  });

  it("a genuine 'no report yet' 404 still shows the empty state", async () => {
    stubRoutes({ list: sessions, get: { status: 404, body: { error: "no report yet — POST /:id/report to generate" } } });
    render(<SessionReport />);
    expect(await screen.findByText(/No report yet/)).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });
});
