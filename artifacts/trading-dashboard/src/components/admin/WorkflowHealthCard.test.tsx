/**
 * Workflow Health headline truth: "Healthy" must cover the bridge aggregate,
 * not only the database ping. The client may only downgrade the server's `ok`.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { WorkflowHealthCard } from "./WorkflowHealthCard";

function payload(over: { ok?: boolean; bridge?: Record<string, unknown>; dbOk?: boolean }) {
  return {
    ok: over.ok ?? true,
    checkedAt: "2026-10-28T10:00:00.000Z",
    apiServer: { listening: true, pid: 1, version: "x", buildTimestamp: null, startedAt: "2026-10-28T09:00:00.000Z", uptimeSeconds: 3600 },
    database: { ok: over.dbOk ?? true, latencyMs: 2 },
    bridge: { total: 0, healthy: 0, stale: 0, down: 0, latestHeartbeatAgeSeconds: null, ...over.bridge },
    notes: [],
  };
}

function stub(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("WorkflowHealthCard headline", () => {
  it("does not say Healthy when every bridge is down, even if the server's ok is true (older server)", async () => {
    stub(payload({ ok: true, bridge: { total: 3, healthy: 0, stale: 0, down: 3 } }));
    render(<WorkflowHealthCard />);
    const badge = await screen.findByTestId("badge-workflow-health");
    expect(badge.textContent).not.toMatch(/Healthy/);
    expect(badge.textContent).toMatch(/Degraded/);
  });

  it("does not say Healthy when the bridge aggregate could not be read", async () => {
    stub(payload({ ok: true, bridge: { readable: false } }));
    render(<WorkflowHealthCard />);
    const badge = await screen.findByTestId("badge-workflow-health");
    expect(badge.textContent).not.toMatch(/Healthy/);
    expect(screen.getByTestId("workflow-health-bridge").textContent).toMatch(/could not be read/i);
  });

  it("flags stale or down bridges instead of a plain Healthy", async () => {
    stub(payload({ ok: true, bridge: { total: 3, healthy: 2, stale: 1, down: 0 } }));
    render(<WorkflowHealthCard />);
    const badge = await screen.findByTestId("badge-workflow-health");
    expect(badge.textContent).not.toBe("Healthy");
    expect(badge.textContent).toMatch(/Attention/);
  });

  it("says Healthy when the DB answers and every registered bridge is fresh", async () => {
    stub(payload({ ok: true, bridge: { total: 2, healthy: 2, readable: true } }));
    render(<WorkflowHealthCard />);
    const badge = await screen.findByTestId("badge-workflow-health");
    expect(badge.textContent).toBe("Healthy");
    expect(badge.getAttribute("title") ?? "").toMatch(/database.*bridge/i);
  });

  it("says Degraded when the server reports not ok", async () => {
    stub(payload({ ok: false, dbOk: false, bridge: { total: 1, healthy: 1 } }));
    render(<WorkflowHealthCard />);
    const badge = await screen.findByTestId("badge-workflow-health");
    expect(badge.textContent).toMatch(/Degraded/);
  });
});
