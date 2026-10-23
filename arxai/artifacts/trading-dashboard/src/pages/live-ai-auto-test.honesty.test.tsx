// live-ai-auto-test.honesty.test.tsx — Feature Truth Audit render proof.
//
// Locks the honesty contract of the admin/dev live-intent test harness:
//   1. The audit-only banner renders (admin/dev tool, no broker execution).
//   2. accepted=false from the backend renders as "submitted for audit/planning
//      validation" — the page NEVER says "trade executed" or shows a fake
//      success state.
//   3. A 401/403 from the backend renders an honest "Access denied" card.
//   4. riskCheckPassed=false renders "Rejected by tester risk check".
//   5. A network failure renders "Network failure" — no local-only success.
//   6. Route containment: /live-ai-auto-test (and aliases) are NOT in the
//      normal-user route allowlist (admin/dev-only page).
//   7. Source honesty: no Math.random in the page source, no hardcoded
//      "Risk governor: active", no misleading x-security-role header.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { isNormalUserAllowedPath } from "@/lib/routeAccess";

// TradingViewLiveChart is heavy (charting lib) — stub it.
vi.mock("@/components/charts/TradingViewLiveChart", () => ({
  default: () => <div data-testid="chart-stub" />,
}));

vi.mock("lucide-react", () => {
  const Stub = () => null;
  return { Bot: Stub, Play: Stub, Pause: Stub, Square: Stub, ShieldAlert: Stub, FlaskConical: Stub };
});

import LiveAiAutoTestPage from "./live-ai-auto-test";

type FetchImpl = (url: string, init?: RequestInit) => Promise<Response> | Promise<never>;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

let submitImpl: FetchImpl;

beforeEach(() => {
  submitImpl = async () => jsonResponse(200, {});
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/live-intent/submit")) return submitImpl(String(url), init);
    // mount-time status reads
    return jsonResponse(200, {});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const AUDIT_OK_BODY = {
  accepted: false,
  riskCheckPassed: true,
  testerAccess: true,
  brokerExecution: false,
  status: "PENDING_MT5_CONNECTION",
  intentId: "intent_test",
  mt5Connected: false,
  reason: "MT5 bridge is not connected yet. Tester workflow was captured, but no real broker order was placed.",
};

async function startLoop() {
  fireEvent.click(screen.getByTestId("auto-start"));
  await waitFor(() => {
    expect(screen.getByTestId("last-result-label")).toBeTruthy();
  });
}

describe("live-ai-auto-test honesty", () => {
  it("renders the admin/dev audit-only banner", () => {
    render(<LiveAiAutoTestPage />);
    const banner = screen.getByTestId("audit-only-banner");
    expect(banner.textContent).toContain("Admin/dev test harness");
    expect(banner.textContent).toContain("audit-only, no broker execution");
    expect(banner.textContent).toContain("accepted=false");
  });

  it("accepted=false renders as audit capture — never 'trade executed'", async () => {
    submitImpl = async () => jsonResponse(200, AUDIT_OK_BODY);
    render(<LiveAiAutoTestPage />);
    await startLoop();
    const label = screen.getByTestId("last-result-label");
    expect(label.textContent).toContain("Intent submitted for audit/planning validation");
    const page = document.body.textContent ?? "";
    expect(page.toLowerCase()).not.toContain("trade executed");
    expect(page.toLowerCase()).not.toContain("trade sent");
    expect(page).toContain("accepted: false");
    expect(page).toContain("brokerExecution: false");
  });

  it("403 renders an honest Access denied card", async () => {
    submitImpl = async () => jsonResponse(403, { error: "Forbidden" });
    render(<LiveAiAutoTestPage />);
    await startLoop();
    expect(screen.getByTestId("last-result-label").textContent).toContain("Access denied");
  });

  it("riskCheckPassed=false renders as rejected by tester risk check", async () => {
    submitImpl = async () =>
      jsonResponse(200, { ...AUDIT_OK_BODY, riskCheckPassed: false, status: "REJECTED_BY_RISK", reason: "Risk check failed: lotSize cap" });
    render(<LiveAiAutoTestPage />);
    await startLoop();
    expect(screen.getByTestId("last-result-label").textContent).toContain("Rejected by tester risk check");
    expect(screen.getByTestId("risk-check-state").textContent).toBe("failed");
  });

  it("network failure renders honestly — no local fake success", async () => {
    submitImpl = async () => { throw new Error("network down"); };
    render(<LiveAiAutoTestPage />);
    await startLoop();
    expect(screen.getByTestId("last-result-label").textContent).toContain("Network failure");
    const page = document.body.textContent ?? "";
    expect(page.toLowerCase()).not.toContain("trade executed");
  });

  it("route containment: harness routes are NOT normal-user allowed", () => {
    for (const p of ["/live-ai-auto-test", "/ai-autopilot", "/ai-decisions"]) {
      expect(isNormalUserAllowedPath(p), `${p} must not be normal-user reachable`).toBe(false);
    }
  });

  it("source honesty: no Math.random, no hardcoded risk-governor state, no x-security-role header", () => {
    const src = fs.readFileSync(path.join(__dirname, "live-ai-auto-test.tsx"), "utf8");
    expect(src).not.toMatch(/Math\.random/);
    expect(src).not.toMatch(/Risk governor.*active/);
    expect(src).not.toMatch(/x-security-role/);
  });
});
