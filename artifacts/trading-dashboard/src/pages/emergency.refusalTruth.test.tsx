// Truth regression: the Control Tower shows why a mode change or kill-switch
// reset was refused.
//
// Before: a refused change comes back as a non-2xx (409 with blockers, 403
// for a non-operator), customFetch throws ApiError, and the page's onError
// showed "Mode change failed" / "Reset failed" with no description. The
// "Blockers:" row never appeared because /system/status always sends
// blockers: [], and a mode not offered read only "Blocked by gate".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

type MutateOpts = { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void; onSettled?: () => void };
const h = vi.hoisted(() => ({
  status: null as unknown,
  statusError: false,
  modeError: null as unknown,
  resetError: null as unknown,
  toasts: [] as Array<{ title?: string; description?: string }>,
}));

function mutation(getError: () => unknown) {
  return {
    isPending: false,
    mutate: (_vars: unknown, opts: MutateOpts) => {
      opts.onError?.(getError());
      opts.onSettled?.();
    },
  };
}

vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useGetSystemStatus: () => ({ data: h.status ?? undefined, isLoading: false, isError: h.statusError }),
  useGetSystemVault: () => ({ data: { events: [] }, isLoading: false, isError: false }),
  useGetSystemStateTransitions: () => ({ data: { transitions: [] }, isLoading: false, isError: false }),
  useSetSystemMode: () => mutation(() => h.modeError),
  useEngageKillSwitch: () => mutation(() => null),
  useResetKillSwitch: () => mutation(() => h.resetError),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: (t: { title?: string; description?: string }) => { h.toasts.push(t); } }),
}));

const { default: Emergency } = await import("./emergency");

const STATUS = {
  operationalMode: "PAPER_TRADING", globalState: "NORMAL", effectiveProfile: {},
  killSwitchEngaged: false, killSwitchEngagedAt: null, killSwitchReason: null,
  mt5LinkHealth: "DEGRADED", lastMt5HeartbeatAt: null, secondsSinceMt5Heartbeat: 40,
  lastModeChangeAt: null, lastModeChangedBy: null, reasons: [], blockers: [],
  allowedModes: ["OBSERVE_ONLY", "SUGGEST_ONLY", "PAPER_TRADING", "LIVE_TRADING"],
};

/** What customFetch throws for a non-2xx: an ApiError carrying status and the parsed body. */
function apiError(status: number, data: unknown) {
  return Object.assign(new Error(`HTTP ${status}`), { name: "ApiError", status, data });
}

beforeEach(() => {
  h.status = { ...STATUS };
  h.statusError = false;
  h.modeError = null;
  h.resetError = null;
  h.toasts = [];
});
afterEach(cleanup);

describe("Control Tower refusals", () => {
  it("a 409 mode change shows the server's blockers in the toast and on the card", async () => {
    h.modeError = apiError(409, { ok: false, mode: "PAPER_TRADING", previousMode: "PAPER_TRADING", reasons: [],
      blockers: ["LIVE_TRADING requires MT5 link OK; current=DEGRADED"] });
    render(<Emergency />);
    fireEvent.click(screen.getByTestId("button-mode-SUGGEST_ONLY"));
    await act(async () => {});
    const last = h.toasts.at(-1)!;
    expect(last.title).toBe("Mode change blocked");
    expect(last.description).toContain("LIVE_TRADING requires MT5 link OK; current=DEGRADED");
    expect(screen.getByTestId("mode-refusal").textContent).toContain("LIVE_TRADING requires MT5 link OK");
  });

  it("a 403 for a non-operator says operator access is required", async () => {
    h.modeError = apiError(403, { error: "FORBIDDEN", message: "Operator access required." });
    render(<Emergency />);
    fireEvent.click(screen.getByTestId("button-mode-SUGGEST_ONLY"));
    await act(async () => {});
    expect(h.toasts.at(-1)!.description).toBe("Operator access required.");
  });

  it("a 409 reset shows why it was refused", async () => {
    h.status = { ...STATUS, killSwitchEngaged: true, allowedModes: ["OBSERVE_ONLY"], operationalMode: "OBSERVE_ONLY" };
    h.resetError = apiError(409, { ok: false, reasons: [], blockers: ["release blocked: acknowledgement missing"] });
    render(<Emergency />);
    fireEvent.click(screen.getByTestId("button-reset-kill-switch"));
    fireEvent.change(await screen.findByPlaceholderText("I_UNDERSTAND_RISK"), { target: { value: "I_UNDERSTAND_RISK" } });
    fireEvent.click(screen.getByText("Confirm Reset"));
    await act(async () => {});
    const last = h.toasts.at(-1)!;
    expect(last.title).toBe("Reset rejected");
    expect(last.description).toContain("release blocked: acknowledgement missing");
    expect(screen.getByTestId("kill-switch-refusal").textContent).toContain("release blocked");
  });

  it("a mode that is not offered says why, from the server's modeBlockers", () => {
    h.status = { ...STATUS, allowedModes: ["OBSERVE_ONLY", "SUGGEST_ONLY", "PAPER_TRADING"],
      modeBlockers: { OBSERVE_ONLY: [], SUGGEST_ONLY: [], PAPER_TRADING: [], LIVE_TRADING: ["LIVE_TRADING requires MT5 link OK; current=DEGRADED"] } };
    render(<Emergency />);
    expect(screen.getByTestId("mode-blockers-LIVE_TRADING").textContent).toContain("requires MT5 link OK; current=DEGRADED");
  });

  it("a mode not offered with no reason from the server does not pretend to know why", () => {
    h.status = { ...STATUS, allowedModes: ["OBSERVE_ONLY", "SUGGEST_ONLY", "PAPER_TRADING"] };
    render(<Emergency />);
    expect(screen.getByTestId("mode-blockers-LIVE_TRADING").textContent).toMatch(/did not say why/);
  });

  it("a status that could not be loaded says so instead of a skeleton forever", () => {
    h.status = null;
    h.statusError = true;
    render(<Emergency />);
    expect(screen.getByTestId("safety-status-error").textContent).toMatch(/could not be loaded/);
  });
});
