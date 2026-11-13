import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let statusResult: { data: unknown; isLoading: boolean; isError: boolean };
vi.mock("@workspace/api-client-react", () => ({
  useGetMt5Status: () => statusResult,
  useGetMeSharedAccountSummary: () => ({ data: null, isLoading: false }),
  getGetMt5StatusQueryKey: () => ["mt5-status"], getGetMeSharedAccountSummaryQueryKey: () => ["shared-summary"],
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@/hooks/useTradingMode", () => ({ useTradingMode: () => ({ isLoading: false, isFrozen: false, isLiveShared: false,
  envelope: { userApprovalStatus: "PENDING", liveExecutionArmed: false } }) }));
vi.mock("@/lib/assistant-name", () => ({ useAssistantName: () => ({ name: "Eleanor" }) }));
const { default: MT5BridgePage } = await import("./mt5-bridge");

const native = { status: "reported", reason: "CLOCK_AND_CONTINUITY_UNVERIFIED", currentVerified: false,
  observedAt: "2026-11-13T10:00:00Z", receivedAt: "2026-11-13T10:00:01Z", observationAgeMs: 1000, currency: "USD", currencyDigits: 2,
  amounts: { balance: "9007199254740993.12", equity: "9007199254741000.34", profit: "-8.76", credit: "10.00", margin: "2.00", freeMargin: "9007199254740998.34" } };
const base = { connected: true, mode: "DEMO", route: "OWN_CONNECTION", accountType: "DEMO", secondsSinceHeartbeat: 2,
  openPositions: [], openPositionsMeasured: false, accountSnapshot: null, sharedMasterBridge: null, nativeAccountReport: native };
beforeEach(() => { statusResult = { data: base, isLoading: false, isError: false }; });
afterEach(cleanup);

it("a reported native account observation cannot become measured refresh, live profit, or execution permission", () => {
  render(<MT5BridgePage />);
  for (const el of screen.getAllByText("Account Refresh")) expect(el.parentElement!.textContent).toContain("Not checked here");
  for (const el of screen.getAllByText("Execution")) expect(el.parentElement!.textContent).not.toContain("Available");
  expect(document.body.textContent).not.toMatch(/verified profit|live profit|current balance|account is approved/i);
  // The native report is not yet a display component. Protect against silently
  // converting its exact decimal strings into the legacy numeric snapshot.
  expect(document.body.textContent).not.toContain("9007199254740993");
  expect(document.body.textContent).not.toContain("9,007,199,254,740,992");
});
it("a rejected latest report does not display retained native amounts as current money", () => {
  statusResult.data = { ...base, nativeAccountReport: { ...native, status: "unavailable", reason: "ACCOUNT_REPORT_REJECTED", amounts: null } };
  render(<MT5BridgePage />);
  expect(document.body.textContent).not.toContain("9007199254740993");
  for (const el of screen.getAllByText("Account Refresh")) expect(el.parentElement!.textContent).toContain("Not checked here");
});
it("a failed status poll cannot use a cached native report to claim a healthy current account", () => {
  statusResult.isError = true;
  render(<MT5BridgePage />);
  expect(screen.getAllByText("Status unknown").length).toBeGreaterThan(0);
  expect(screen.queryByText("Connected")).toBeNull();
  expect(document.body.textContent).not.toMatch(/verified profit|live profit|current balance/i);
});
