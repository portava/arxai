import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router, useLocation } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { AuthGate } from "./AuthGate";
import { readReturnTo } from "@/lib/authReturnTo";

// Use the real AuthGate and useCurrentUser; only the public page content and
// network boundary are fixtures. No provider, DB or browser credentials.
vi.mock("@/pages/login", () => ({ default: () => <h1>Fixture sign in</h1> }));
vi.mock("@/pages/register", () => ({ default: () => <h1>Fixture register</h1> }));
vi.mock("@/pages/reset-password", () => ({ default: () => <h1>Fixture reset</h1> }));

const user = { id: 1, email: "fixture@example.invalid", name: null, role: "USER", lastLoginAt: null, createdAt: "", updatedAt: "" };
const privateKey = ["private-settings"];
let client: QueryClient;
let reply: number | "network";

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  reply = 200;
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("/api/me");
    expect(init?.credentials).toBe("include");
    if (reply === "network") throw new TypeError("offline connection fixture");
    return new Response(JSON.stringify(reply === 200 ? { user } : { error: reply === 401 ? "AUTH_REQUIRED" : "SESSION_CHECK_UNAVAILABLE" }), { status: reply });
  }));
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
});

function LocationReadout() {
  const [location] = useLocation();
  return <output data-testid="location">{location}</output>;
}

function mountGate() {
  const { hook } = memoryLocation({ path: "/settings" });
  return render(
    <QueryClientProvider client={client}>
      <Router hook={hook}>
        <LocationReadout />
        <AuthGate><h1>Private workspace</h1></AuthGate>
      </Router>
    </QueryClientProvider>,
  );
}

describe("session availability at the auth boundary", () => {
  it.each(["network", 500, 503] as const)("initial %s failure blocks private content without redirecting, then retry recovers", async (failure) => {
    reply = failure;
    mountGate();
    await screen.findByTestId("session-check-error");
    expect(screen.getByTestId("location").textContent).toBe("/settings");
    expect(screen.queryByText("Private workspace")).toBeNull();
    expect(screen.queryByText("Fixture sign in")).toBeNull();
    expect(readReturnTo()).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    reply = 200;
    fireEvent.click(screen.getByRole("button", { name: "Retry session check" }));
    await screen.findByText("Private workspace");
    expect(screen.queryByTestId("session-check-error")).toBeNull();
    expect(screen.getByTestId("location").textContent).toBe("/settings");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("a retry that confirms an expired or revoked session redirects to sign in", async () => {
    reply = 503;
    mountGate();
    await screen.findByTestId("session-check-error");
    reply = 401;
    fireEvent.click(screen.getByRole("button", { name: "Retry session check" }));
    await screen.findByText("Fixture sign in");
    expect(screen.getByTestId("location").textContent).toBe("/login");
    expect(screen.queryByText("Private workspace")).toBeNull();
    expect(readReturnTo()).toBe("/settings");
  });

  it.each(["network", 503] as const)("background %s failure preserves cached identity; confirmed 401 still clears private state", async (failure) => {
    client.setQueryData(["me"], user);
    client.setQueryData(privateKey, { fixture: "private cached settings" });
    window.localStorage.setItem("highroll.activeSymbol", "fixture");
    mountGate();
    await screen.findByText("Private workspace");

    reply = failure;
    await act(async () => { await client.refetchQueries({ queryKey: ["me"], exact: true }); });
    await waitFor(() => expect(client.getQueryState(["me"])?.status).toBe("error"));
    expect(screen.getByText("Private workspace")).toBeDefined();
    expect(screen.queryByTestId("session-check-error")).toBeNull();
    expect(screen.getByTestId("location").textContent).toBe("/settings");
    expect(client.getQueryData(privateKey)).toBeDefined();
    expect(window.localStorage.getItem("highroll.activeSymbol")).toBe("fixture");

    reply = 200;
    await act(async () => { await client.refetchQueries({ queryKey: ["me"], exact: true }); });
    expect(client.getQueryState(["me"])?.status).toBe("success");
    expect(client.getQueryData(privateKey)).toBeDefined();

    reply = 401;
    await act(async () => { await client.refetchQueries({ queryKey: ["me"], exact: true }); });
    await screen.findByText("Fixture sign in");
    expect(client.getQueryData(["me"])).toBeNull();
    expect(client.getQueryData(privateKey)).toBeUndefined();
    expect(window.localStorage.getItem("highroll.activeSymbol")).toBeNull();
    expect(screen.queryByText("Private workspace")).toBeNull();
  });
});
