// Replay Simulator: loading the scenario list did not check the response
// status. A 500 {error:"list scenarios failed"} has no `scenarios`, so the
// page set an empty list and showed "No replay scenarios yet ... Create a
// synthetic scenario to start." although the list could not be read.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/components/ss/PageShell", async (orig) => {
  const real = await orig<typeof import("@/components/ss/PageShell")>();
  return { ...real, PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});

const { default: ReplaySimulator } = await import("./replay-simulator");

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Replay Simulator scenario list failure", () => {
  it("a 500 from the scenario list is 'could not be loaded', not 'No replay scenarios yet'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 500, json: async () => ({ error: "list scenarios failed", detail: "db down" }),
    })));
    render(<ReplaySimulator />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be loaded/i);
    expect(alert.textContent).toMatch(/list scenarios failed/);
    expect(screen.queryByText("No replay scenarios yet")).toBeNull();
  });

  it("a non-JSON error page is also 'could not be loaded'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <"); },
    })));
    render(<ReplaySimulator />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not be loaded/i);
    expect(screen.queryByText("No replay scenarios yet")).toBeNull();
  });

  it("an empty list that loaded is still the empty state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ scenarios: [], count: 0 }) })));
    render(<ReplaySimulator />);
    expect(await screen.findByText("No replay scenarios yet")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
