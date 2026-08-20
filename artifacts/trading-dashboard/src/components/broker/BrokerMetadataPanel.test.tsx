import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Render coverage for the deliberately read-only broker metadata disclosure.
 * Route-level tenant isolation and read-only enforcement live in API tests; this
 * suite protects only the user-facing states and the generated-hook wiring.
 */
const hooks = vi.hoisted(() => ({
  connection: vi.fn(),
  account: vi.fn(),
  capabilities: vi.fn(),
  instruments: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  getGetMyBrokerHubConnectionQueryKey: (id: number) => ["broker-connection", id],
  getGetMyBrokerHubAccountQueryKey: (id: number) => ["broker-account", id],
  getGetMyBrokerHubCapabilitiesQueryKey: (id: number) => ["broker-capabilities", id],
  getGetMyBrokerHubInstrumentsQueryKey: (id: number) => ["broker-instruments", id],
  useGetMyBrokerHubConnection: (...args: unknown[]) => hooks.connection(...args),
  useGetMyBrokerHubAccount: (...args: unknown[]) => hooks.account(...args),
  useGetMyBrokerHubCapabilities: (...args: unknown[]) => hooks.capabilities(...args),
  useGetMyBrokerHubInstruments: (...args: unknown[]) => hooks.instruments(...args),
}));

import { BrokerMetadataPanel } from "./BrokerMetadataPanel";

const idle = { data: undefined, error: null, isLoading: false };

function setHookState(overrides: Partial<Record<keyof typeof hooks, unknown>> = {}) {
  hooks.connection.mockReturnValue(overrides.connection ?? idle);
  hooks.account.mockReturnValue(overrides.account ?? idle);
  hooks.capabilities.mockReturnValue(overrides.capabilities ?? idle);
  hooks.instruments.mockReturnValue(overrides.instruments ?? idle);
}

beforeEach(() => {
  vi.clearAllMocks();
  setHookState();
});

afterEach(() => cleanup());

describe("BrokerMetadataPanel", () => {
  it("enables the generated broker-hub queries only after the disclosure expands", () => {
    render(<BrokerMetadataPanel conn={{ id: 42 }} />);

    for (const hook of Object.values(hooks)) {
      expect(hook).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ query: expect.objectContaining({ enabled: false }) }),
      );
    }
    expect(screen.queryByText("Account snapshot")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /broker metadata/i }));

    for (const hook of Object.values(hooks)) {
      expect(hook).toHaveBeenLastCalledWith(
        42,
        expect.objectContaining({ query: expect.objectContaining({ enabled: true }) }),
      );
    }
    expect(screen.getByText("Account snapshot")).toBeTruthy();
  });

  it("renders loading evidence while expanded", () => {
    setHookState({
      connection: { data: undefined, error: null, isLoading: true },
      account: { data: undefined, error: null, isLoading: true },
      capabilities: { data: undefined, error: null, isLoading: true },
      instruments: { data: undefined, error: null, isLoading: true },
    });
    render(<BrokerMetadataPanel conn={{ id: 42 }} />);

    fireEvent.click(screen.getByRole("button", { name: /broker metadata/i }));

    expect(screen.getByText("Checking connection…")).toBeTruthy();
    expect(screen.getByText("Loading discovered instruments…")).toBeTruthy();
  });

  it("renders 404 metadata as a quiet unavailable state, not an error banner", () => {
    const notFound = { status: 404 };
    setHookState({
      connection: { data: undefined, error: notFound, isLoading: false },
      account: { data: undefined, error: notFound, isLoading: false },
      capabilities: { data: undefined, error: notFound, isLoading: false },
      instruments: { data: undefined, error: notFound, isLoading: false },
    });
    render(<BrokerMetadataPanel conn={{ id: 42 }} />);

    fireEvent.click(screen.getByRole("button", { name: /broker metadata/i }));

    expect(screen.getByText(/Broker metadata is currently unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/Temporarily unavailable/i)).toBeNull();
    expect(screen.queryByText("Account snapshot")).toBeNull();
  });

  it("shows masked account evidence, capabilities, and DISCOVERY_REQUIRED without execution controls", () => {
    setHookState({
      connection: {
        data: {
          connected: true,
          venue: "MT5",
          status: "CONNECTED",
          reason: "HEARTBEAT_OK",
          observedAt: "2026-08-20T10:00:00.000Z",
        },
        error: null,
        isLoading: false,
      },
      account: {
        data: {
          accountRefMasked: "•••• 4821",
          brokerName: "Example Broker",
          serverName: "Example-Live",
          environment: "LIVE",
          currency: "USD",
          snapshotStatus: "FRESH",
        },
        error: null,
        isLoading: false,
      },
      capabilities: {
        data: { capabilities: { accountSnapshot: true, instrumentDiscovery: false } },
        error: null,
        isLoading: false,
      },
      instruments: {
        data: { discoveryStatus: "DISCOVERY_REQUIRED", instruments: [] },
        error: null,
        isLoading: false,
      },
    });
    const { container } = render(<BrokerMetadataPanel conn={{ id: 42 }} />);

    fireEvent.click(screen.getByRole("button", { name: /broker metadata/i }));

    expect(screen.getByText("•••• 4821")).toBeTruthy();
    expect(container.textContent).not.toContain("123456789");
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getByText("Unavailable")).toBeTruthy();
    expect(screen.getByText(/DISCOVERY_REQUIRED — no fresh broker-reported instruments/i)).toBeTruthy();

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /trade|execute|automate|start/i })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});