import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useTradingMode", () => ({
  useTradingMode: () => ({
    isLoading: false,
    envelope: {},
    shouldShowAdminDiagnostics: true,
    isAdminPreviewingUserMode: false,
  }),
}));

import AdminBridgeDiagnosticsPage from "./bridge-diagnostics";

type Json = Record<string, unknown>;
const CONN = {
  id: 11, userId: 3, connectionName: "Master VPS", status: "connected", accountType: "live",
  broker: "Broker", server: "Broker-Live", eaVersion: "1.27", tokenLast4: "abcd",
  tokenRotatedAt: null, tokenRevokedAt: null, previousTokenExpiresAt: null, graceWindowActive: false,
  lastHeartbeatAt: new Date().toISOString(), heartbeatAgeSeconds: 3,
};
const VERDICT = {
  connectionId: 11, connectionName: "Master VPS", liveness: "fresh", conditions: [],
  heartbeatAgeSeconds: 3, summary: "Bridge healthy (heartbeat 3s ago).", shouldAlert: false,
};
const ORPHAN = {
  id: "orphan-1", type: "ORPHAN_BROKER_POSITION", severity: "critical", userId: 3,
  bridgeConnectionId: 11, commandId: null, brokerTicket: "9001", symbol: "EURUSD", status: "open",
  reason: "Broker position with no ARX command.", recommendedAction: "Review in Reconciliation Center.",
  createdAt: null, updatedAt: null,
};

type Routes = Partial<Record<"connections" | "watchdog" | "retcodes" | "issues" | "symbols", Json | Error>>;
function okRoutes(): Routes {
  return {
    connections: { ok: true, connections: [CONN] },
    watchdog: { ok: true, verdicts: [VERDICT] },
    retcodes: { ok: true, retcodes: [{ code: 10009, key: "TRADE_RETCODE_DONE", friendly: "Done", transient: false, success: true }] },
    issues: { ok: true, issues: [] },
    symbols: { ok: true, symbols: [] },
  };
}
function routeKey(url: string): keyof Routes {
  if (url.includes("/admin/bridge/connections")) return "connections";
  if (url.includes("/admin/bridge/watchdog")) return "watchdog";
  if (url.includes("/admin/ea/retcodes")) return "retcodes";
  if (url.includes("/admin/ea/reconciliation-issues")) return "issues";
  if (url.includes("/admin/ea/symbol-capabilities")) return "symbols";
  throw new Error(`unexpected fetch ${url}`);
}
function stubFetch(sequence: Routes[]) {
  let call = 0;
  const seen: Record<string, number> = {};
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const key = routeKey(String(url));
    seen[key] = (seen[key] ?? 0) + 1;
    const routes = sequence[Math.min(seen[key] - 1, sequence.length - 1)]!;
    call += 1;
    const body = routes[key];
    if (body instanceof Error) throw body;
    return { ok: (body as Json).ok === true, status: (body as Json).ok === true ? 200 : 500, json: async () => body } as Response;
  }));
  return () => call;
}
async function settle() {
  await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("bridge diagnostics — a failed endpoint is 'could not be loaded', never empty or offline", () => {
  it("baseline: everything loaded and clean reads clean", async () => {
    stubFetch([okRoutes()]);
    render(<AdminBridgeDiagnosticsPage />); await settle();
    expect(screen.getByTestId("orphans-none")).toBeTruthy();
    expect(screen.getByTestId("duplicates-none")).toBeTruthy();
    expect(screen.getByTestId("conn-row-11").textContent).toContain("FRESH");
    expect(screen.queryByTestId("bridge-diag-load-failures")).toBeNull();
  });

  it("reconciliation issues {ok:false}: no 'No orphan positions detected.', and the failure is shown", async () => {
    stubFetch([{ ...okRoutes(), issues: { ok: false, error: "reconciliation_failed" } }]);
    render(<AdminBridgeDiagnosticsPage />); await settle();
    expect(screen.queryByText("No orphan positions detected.")).toBeNull();
    expect(screen.queryByText("No stale commands or heartbeats.")).toBeNull();
    expect(screen.getByTestId("orphans-unavailable").textContent).toMatch(/could not be loaded/);
    expect(screen.getByTestId("bridge-diag-load-failures").textContent).toMatch(/Reconciliation issues.*reconciliation_failed/);
  });

  it("watchdog {ok:false}: the bridge badge is not OFFLINE and duplicates are not 'none detected'", async () => {
    stubFetch([{ ...okRoutes(), watchdog: { ok: false, error: "INTERNAL" } }]);
    render(<AdminBridgeDiagnosticsPage />); await settle();
    const row = screen.getByTestId("conn-row-11");
    expect(row.textContent).not.toContain("OFFLINE");
    expect(screen.getByTestId("liveness-11").textContent).toBe("LIVENESS NOT CHECKED");
    expect(screen.queryByText("No duplicate-bridge conflicts detected.")).toBeNull();
    expect(screen.getByTestId("duplicates-unavailable").textContent).toMatch(/could not be loaded/);
  });

  it("watchdog loaded but has no verdict for a non-revoked bridge: NO VERDICT, not OFFLINE", async () => {
    stubFetch([{ ...okRoutes(), watchdog: { ok: true, verdicts: [] } }]);
    render(<AdminBridgeDiagnosticsPage />); await settle();
    expect(screen.getByTestId("liveness-11").textContent).toBe("NO WATCHDOG VERDICT");
  });

  it("a revoked bridge without a verdict reads REVOKED", async () => {
    const r = okRoutes();
    r.connections = { ok: true, connections: [{ ...CONN, tokenRevokedAt: new Date().toISOString() }] };
    r.watchdog = { ok: true, verdicts: [] };
    stubFetch([r]);
    render(<AdminBridgeDiagnosticsPage />); await settle();
    expect(screen.getByTestId("liveness-11").textContent).toBe("REVOKED");
  });

  it("a later failed refresh drops the earlier poll's issues and liveness instead of showing them as current", async () => {
    const first = okRoutes();
    first.issues = { ok: true, issues: [ORPHAN] };
    const second = { ...okRoutes(), issues: new Error("network down"), watchdog: { ok: false, error: "INTERNAL" } };
    stubFetch([first, second]);
    render(<AdminBridgeDiagnosticsPage />); await settle();
    expect(screen.getByTestId("orphan-orphan-1")).toBeTruthy();
    expect(screen.getByTestId("liveness-11").textContent).toBe("FRESH");
    fireEvent.click(screen.getByTestId("bridge-diag-refresh")); await settle();
    expect(screen.queryByTestId("orphan-orphan-1")).toBeNull();
    expect(screen.getByTestId("orphans-unavailable")).toBeTruthy();
    expect(screen.getByTestId("liveness-11").textContent).toBe("LIVENESS NOT CHECKED");
    expect(screen.getByTestId("bridge-diag-load-failures").textContent).toMatch(/network down/);
  });

  it("bridge list, symbol capabilities and retcodes that fail are not 'none'", async () => {
    stubFetch([{
      ...okRoutes(),
      connections: { ok: false, error: "FORBIDDEN" },
      symbols: { ok: false, error: "INTERNAL" },
      retcodes: { ok: false, error: "INTERNAL" },
    }]);
    render(<AdminBridgeDiagnosticsPage />); await settle();
    expect(screen.queryByText("No bridges registered.")).toBeNull();
    expect(screen.queryByText("No symbol specs reported yet.")).toBeNull();
    expect(screen.queryByText("No retcodes match.")).toBeNull();
    expect(screen.getByTestId("conns-unavailable")).toBeTruthy();
    expect(screen.getByTestId("symbols-unavailable")).toBeTruthy();
    expect(screen.getByTestId("retcodes-unavailable")).toBeTruthy();
  });
});

describe("bridge diagnostics — symbol capabilities the EA did not report", () => {
  const SPEC = {
    userId: 3, symbol: "EURUSD", brokerSymbol: "EURUSD.r", accountType: "live",
    visible: null, tradeAllowed: null, tradeMode: null, marketOpen: null,
    minVolume: 0.01, maxVolume: 100, volumeStep: 0.01, spreadPoints: 12, stopsLevelPoints: 0,
    reportedAgeSeconds: 30,
  };

  it("unreported visibility and tradability read '—', not 'no'", async () => {
    stubFetch([{ ...okRoutes(), symbols: { ok: true, symbols: [SPEC] } }]);
    render(<AdminBridgeDiagnosticsPage />); await settle();
    const cells = screen.getByTestId("symbol-row-3-EURUSD").querySelectorAll("td");
    expect(cells[3]!.textContent).toBe("—");
    expect(cells[4]!.textContent).toBe("—");
    expect(cells[5]!.textContent).toBe("—");
  });

  it("reported values still read yes / no", async () => {
    stubFetch([{ ...okRoutes(), symbols: { ok: true, symbols: [{ ...SPEC, visible: true, tradeAllowed: false, marketOpen: true }] } }]);
    render(<AdminBridgeDiagnosticsPage />); await settle();
    const cells = screen.getByTestId("symbol-row-3-EURUSD").querySelectorAll("td");
    expect(cells[3]!.textContent).toBe("yes");
    expect(cells[4]!.textContent).toBe("no");
    expect(cells[5]!.textContent).toBe("open");
  });
});
