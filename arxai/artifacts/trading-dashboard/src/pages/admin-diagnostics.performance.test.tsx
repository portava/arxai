import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PerfPanel } from "./admin-diagnostics";

vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Eleanor" }) }));
vi.mock("@/lib/perf", () => ({ setPerfTransportEnabled: vi.fn() }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("renders tail latency, errors and pool pressure in the existing diagnostics panel", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("action-summary") ? {
    actions: [{ action: "GET /api/test", count: 100, p50Ms: 10, p95Ms: 20, p99Ms: 90, maxMs: 95, errorCount: 3, slowCount: 0 }],
    runtime: { cpuPercent: 12, eventLoopUtilization: .2, memory: { rssBytes: 104857600, heapUsedBytes: 52428800 }, database: { total: 10, idle: 0, waiting: 2 }, alerts: ["DATABASE_POOL_WAITING"] },
  } : { rows: [] } })));
  render(<PerfPanel />);
  await waitFor(() => expect(screen.getByTestId("runtime-metrics").textContent).toContain("100.0 MiB"));
  expect(screen.getByText("p99")).toBeTruthy();
  expect(screen.getByText("5xx")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("waiting for a connection");
});

it("aborts outstanding diagnostics reads on unmount", () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => {
    signals.push(options.signal as AbortSignal);
    return new Promise(() => {});
  }));
  const page = render(<PerfPanel />);
  expect(signals).toHaveLength(2);
  page.unmount();
  expect(signals.every(signal => signal.aborted)).toBe(true);
});
