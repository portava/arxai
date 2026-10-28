// Operator feedback while one autonomous cycle runs. The protective path may
// wait up to 20 s for a fresh EA position snapshot inside the request, so the
// page must show waiting feedback at once, count elapsed time, stay usable,
// say plainly when the wait runs long, and never present a protective
// dispatch ("sent to EA") as a close or a completed action.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import type { RunAutonomousCycleResp } from "@workspace/api-client-react";

const h = vi.hoisted(() => ({
  runCycle: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAdminRunSelfTradeAutonomousCycle: () =>
    useMutation({ mutationFn: (vars: { data: { reason: string } }) => h.runCycle(vars) }),
  useGetSelfTradeExecutions: () => ({
    data: { executions: [] },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: h.refetch,
  }),
  useGetSelfTradeKillSwitches: () => ({ data: { killSwitches: [] }, isLoading: false }),
  useAdminToggleSelfTradeKillSwitch: () => ({ mutate: vi.fn(), isPending: false }),
}));
import { AutonomousExecutionTab } from "@/pages/admin/self-trade-ai";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const TIMEOUT_TEXT =
  "Timed out: no broker position snapshot newer than the held one arrived from the EA within the 20 s wait. ARX did not close or move a stop from old data and re-checks next cycle. Manual controls and the stop held at the broker remain active.";
const BUDGET_TEXT =
  "No fresh broker position snapshot was available, and this bridge's wait budget for the cycle (20 s) was already used by an earlier held position (one snapshot refreshes every position on the bridge). ARX did not act on old data and re-checks next cycle. Manual controls and the stop held at the broker remain active.";
const STALE_TEXT =
  "The latest broker position snapshot was too old for ordinary management to act on. Where a protective trigger applied, the position was handed to the protective path, which waits for a fresh snapshot (see protective results).";

function response(over: Partial<RunAutonomousCycleResp> = {}): RunAutonomousCycleResp {
  return {
    ok: true,
    cycleId: "cycle-qa",
    decisionsConsidered: 0,
    executed: {},
    agentsManaged: 1,
    positionsModified: 0,
    positionsClosed: 0,
    reconciled: { filled: 0, rejected: 0, closed: 0, expired: 0 },
    realizedPosted: 0,
    managementHeld: { PROTECTIVE_HOLD_NO_FRESH_SWEEP: 1, PROTECTIVE_HOLD_WAIT_BUDGET_USED: 1, MANAGEMENT_OBSERVATION_STALE: 4 },
    managementHeldDetails: [
      { reason: "PROTECTIVE_HOLD_NO_FRESH_SWEEP", count: 1, kind: "PROTECTIVE", text: TIMEOUT_TEXT },
      { reason: "PROTECTIVE_HOLD_WAIT_BUDGET_USED", count: 1, kind: "PROTECTIVE", text: BUDGET_TEXT },
      { reason: "MANAGEMENT_OBSERVATION_STALE", count: 4, kind: "OBSERVATION", text: STALE_TEXT },
    ],
    protective: { considered: 4, acted: 2, held: 2, bridges: 1, elapsedMs: 20_000, waitBudgetMs: 20_000 },
    ...over,
  };
}

function renderTab() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AutonomousExecutionTab />
    </QueryClientProvider>,
  );
}

const runButton = () => screen.getByRole("button", { name: /run cycle|running cycle/i });
const cycleReason = () => screen.getByPlaceholderText("why this run (≥3 chars)");
const status = () => screen.getByTestId("run-cycle-status");
const txt = (el: Element) => el.textContent ?? "";

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function startRun() {
  fireEvent.change(cycleReason(), { target: { value: "qa protective wait" } });
  fireEvent.click(runButton());
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date("2026-10-28T04:00:00Z"));
  h.runCycle.mockReset();
  h.refetch.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("run autonomous cycle: waiting feedback", () => {
  it("shows waiting feedback in the same render as the click, inside a polite live region", () => {
    const d = deferred<RunAutonomousCycleResp>();
    h.runCycle.mockReturnValue(d.promise);
    renderTab();
    const region = status();
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    startRun();
    // No timer advanced, no promise settled: the click itself rendered this.
    expect(txt(status())).toMatch(/cycle running/i);
    expect(txt(status())).toMatch(/0 s elapsed/);
    expect(txt(status())).toMatch(/up to 20 s for a fresh broker position snapshot/i);
    expect((runButton() as HTMLButtonElement).disabled).toBe(true);
    expect(txt(runButton())).toMatch(/running cycle/i);
  });

  it("counts elapsed seconds across the 20 s wait, blocks double submit, and leaves the page usable", async () => {
    const d = deferred<RunAutonomousCycleResp>();
    h.runCycle.mockReturnValue(d.promise);
    renderTab();
    startRun();
    await advance(5_000);
    expect(txt(status())).toMatch(/5 s elapsed/);
    await advance(15_000);
    expect(txt(status())).toMatch(/20 s elapsed/);
    expect(txt(status())).not.toMatch(/taking longer than expected/i);

    fireEvent.click(runButton());
    expect(h.runCycle).toHaveBeenCalledTimes(1);

    // The rest of the page keeps working while the request is pending.
    fireEvent.change(cycleReason(), { target: { value: "next run note" } });
    expect((cycleReason() as HTMLInputElement).value).toBe("next run note");
    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect((refresh as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(refresh);
    expect(h.refetch).toHaveBeenCalledTimes(1);
    const killReason = screen.getAllByRole("textbox").find((el) => el !== cycleReason() && !el.hasAttribute("disabled"));
    expect(killReason).toBeTruthy();

    // Still no outcome claimed while pending.
    expect(screen.queryByText(/sent to EA/i)).toBeNull();
    d.resolve(response());
    await advance(0);
  });

  it("says the wait is taking longer than expected after 45 s, without claiming any outcome", async () => {
    const d = deferred<RunAutonomousCycleResp>();
    h.runCycle.mockReturnValue(d.promise);
    renderTab();
    startRun();
    await advance(45_000);
    expect(txt(status())).not.toMatch(/taking longer than expected/i);
    await advance(1_000);
    expect(txt(status())).toMatch(/46 s elapsed/);
    expect(txt(status())).toMatch(/taking longer than expected/i);
    expect(txt(status())).toMatch(/no outcome is known yet/i);
    expect(status().textContent ?? "").not.toMatch(/closed|completed|sent to EA|succeeded/i);
    d.resolve(response());
    await advance(0);
  });
});

describe("run autonomous cycle: result", () => {
  it("renders sent-to-EA wording, the wait, and every hold reason with its explanation", async () => {
    h.runCycle.mockReturnValue(Promise.resolve(response()));
    renderTab();
    startRun();
    await advance(0);
    // Waiting is over (the button is disabled again only because the reason was cleared).
    expect(txt(runButton())).not.toMatch(/running/i);
    expect((cycleReason() as HTMLInputElement).value).toBe("");
    expect(txt(status())).not.toMatch(/elapsed/);
    expect(txt(status())).toMatch(/cycle finished/i);

    const protective = screen.getByRole("region", { name: /protective path/i });
    const p = within(protective);
    expect(p.getByText(/considered 4/i)).toBeTruthy();
    expect(p.getByText(/sent to EA — awaiting broker confirmation 2/i)).toBeTruthy();
    expect(p.getByText(/held 2/i)).toBeTruthy();
    expect(p.getByText(/waited 20(\.0)? s of 20 s/i)).toBeTruthy();
    expect(protective.textContent ?? "").not.toMatch(/\bclosed\b|\bcompleted\b/i);

    const holds = within(screen.getByRole("list", { name: /hold reasons/i }));
    expect(holds.getByText("PROTECTIVE_HOLD_NO_FRESH_SWEEP")).toBeTruthy();
    expect(holds.getByText(TIMEOUT_TEXT)).toBeTruthy();
    expect(holds.getByText("PROTECTIVE_HOLD_WAIT_BUDGET_USED")).toBeTruthy();
    expect(holds.getByText(BUDGET_TEXT)).toBeTruthy();
    expect(holds.getByText("MANAGEMENT_OBSERVATION_STALE")).toBeTruthy();
    expect(holds.getByText(STALE_TEXT)).toBeTruthy();
    expect(holds.getAllByText(/×\s*\d+/)).toHaveLength(3);
    // Nowhere on the page is a protective dispatch called completed.
    expect(document.body.textContent ?? "").not.toMatch(/completed/i);
  });

  it("shows the error and clears the waiting state when the request fails", async () => {
    h.runCycle.mockImplementation(() => Promise.reject(new Error("HTTP 500 run-cycle failed")));
    renderTab();
    startRun();
    await advance(0);
    expect(screen.getByText(/HTTP 500 run-cycle failed/)).toBeTruthy();
    expect(txt(status())).not.toMatch(/elapsed/);
    expect(txt(status())).toMatch(/request failed/i);
    expect((runButton() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/sent to EA/i)).toBeNull();
  });

  it("tolerates an older server that omits the protective and hold fields", async () => {
    const { managementHeld: _m, managementHeldDetails: _d, protective: _p, ...legacy } = response();
    h.runCycle.mockReturnValue(Promise.resolve(legacy as RunAutonomousCycleResp));
    renderTab();
    startRun();
    await advance(0);
    expect(txt(status())).toMatch(/cycle finished/i);
    expect(screen.getByText(/did not report protective-path results/i)).toBeTruthy();
  });
});
