// Operator feedback while one autonomous cycle runs. The protective path may
// wait up to 20 s for a fresh EA position snapshot inside the request, so the
// page must show waiting feedback at once, count elapsed time, stay usable,
// say plainly when the wait runs long, and never present a protective
// dispatch ("sent to EA") as a close or a completed action.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, onlineManager, useMutation } from "@tanstack/react-query";
import type { RunAutonomousCycleResp } from "@workspace/api-client-react";

const h = vi.hoisted(() => ({
  runCycle: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // Like the generated hook: caller options (mutationKey, onSuccess) are kept.
  useAdminRunSelfTradeAutonomousCycle: (opts?: { mutation?: Record<string, unknown> }) =>
    useMutation({ ...(opts?.mutation ?? {}), mutationFn: (vars: { data: { reason: string } }) => h.runCycle(vars) }),
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
  const tree = (show: boolean) => (
    <QueryClientProvider client={client}>{show ? <AutonomousExecutionTab /> : <div>another tab</div>}</QueryClientProvider>
  );
  const view = render(tree(true));
  return {
    ...view,
    client,
    /** Radix TabsContent unmounts an inactive tab; this is the same unmount / remount. */
    switchAway: () => view.rerender(tree(false)),
    switchBack: () => view.rerender(tree(true)),
  };
}

const runButton = () => screen.getByRole("button", { name: /run cycle|running cycle/i });
const cycleReason = () => screen.getByPlaceholderText("why this run (≥3 chars)");
const status = () => screen.getByTestId("run-cycle-status");
const announce = () => screen.getByTestId("run-cycle-announce");
/** Run is blocked with aria-disabled; it is never natively disabled (that drops keyboard focus). */
const blocked = (el: HTMLElement) => {
  expect((el as HTMLButtonElement).disabled).toBe(false);
  return el.getAttribute("aria-disabled") === "true";
};
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
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("run autonomous cycle: waiting feedback", () => {
  it("shows waiting feedback in the same render as the click, inside a polite live region", () => {
    const d = deferred<RunAutonomousCycleResp>();
    h.runCycle.mockReturnValue(d.promise);
    renderTab();
    const region = announce();
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    startRun();
    // No timer advanced, no promise settled: the click itself rendered this.
    expect(txt(status())).toMatch(/cycle running/i);
    expect(txt(status())).toMatch(/0 s elapsed/);
    expect(txt(status())).toMatch(/up to 20 s for a fresh broker position snapshot/i);
    expect(txt(announce())).toMatch(/cycle started; waiting for the server/i);
    expect(blocked(runButton())).toBe(true);
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
    expect(p.getByText(/protective step took 20\.0 s \(sweep wait budget 20 s\)/i)).toBeTruthy();
    expect(p.getByText(/queued in the EA mailbox/i)).toBeTruthy();
    expect(p.getByText(/can still expire or be rejected/i)).toBeTruthy();
    expect(protective.textContent ?? "").not.toMatch(/handed to the terminal/i);
    expect(protective.textContent ?? "").not.toMatch(/waited/i);
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

  it("splits command-recorded / outcome-unknown protective results out of 'held'", async () => {
    h.runCycle.mockReturnValue(
      Promise.resolve(
        response({
          protective: {
            considered: 3, acted: 0, held: 2, commandRecordedOrUnknown: 1, bridges: 1, elapsedMs: 900, waitBudgetMs: 20_000,
          },
        }),
      ),
    );
    renderTab();
    startRun();
    await advance(0);
    const p = within(screen.getByRole("region", { name: /protective path/i }));
    expect(p.getByText(/^held 2$/i)).toBeTruthy();
    expect(p.getByText(/command recorded \/ outcome unknown 1/i)).toBeTruthy();
    expect(p.getByText(/may have reached the terminal/i)).toBeTruthy();
  });

  it("shows the error and clears the waiting state when the request fails", async () => {
    h.runCycle.mockImplementation(() =>
      Promise.reject(Object.assign(new Error("HTTP 500 run-cycle failed"), { status: 500 })),
    );
    renderTab();
    startRun();
    await advance(0);
    expect(screen.getByText(/HTTP 500 run-cycle failed/)).toBeTruthy();
    expect(txt(status())).not.toMatch(/elapsed/);
    expect(txt(status())).toMatch(/request failed/i);
    expect(blocked(runButton())).toBe(false);
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

describe("run autonomous cycle: a cycle that did not finish", () => {
  const completion = (over: Partial<NonNullable<RunAutonomousCycleResp["completion"]>>) => ({
    status: "COMPLETED" as const,
    stopReason: null,
    decisionsFailed: 0,
    decisionsNotStarted: 0,
    agentsFailed: 0,
    agentsNotStarted: 0,
    managementStepFailed: false,
    protectiveNotRun: 0,
    dbWaitTimeouts: 0,
    dbConnectionFailures: 0,
    ...over,
  });

  it("a finished cycle shows no warning", async () => {
    h.runCycle.mockReturnValue(Promise.resolve(response({ completion: completion({}) })));
    renderTab();
    startRun();
    await advance(0);
    expect(txt(status())).toMatch(/cycle finished/i);
    expect(screen.queryByRole("region", { name: /did not finish/i })).toBeNull();
  });

  it("INCOMPLETE says which steps failed and never says the cycle finished", async () => {
    h.runCycle.mockReturnValue(
      Promise.resolve(response({ completion: completion({ status: "INCOMPLETE", decisionsFailed: 1, agentsFailed: 2, dbWaitTimeouts: 3, dbConnectionFailures: 1 }) })),
    );
    renderTab();
    startRun();
    await advance(0);
    expect(txt(status())).toMatch(/without finishing every step/i);
    expect(txt(status())).not.toMatch(/cycle finished/i);
    const region = within(screen.getByRole("region", { name: /did not finish/i }));
    const text = region.getByText(/did not finish every step/i).textContent ?? "";
    expect(text).toMatch(/1 decision failed while executing \(outcome not proven\)/);
    expect(text).toMatch(/management failed for 2 agents/);
    expect(text).toMatch(/3 database waits timed out/);
    expect(text).toMatch(/1 database connection lost \(outcome of the step not proven\)/);
    expect(region.getByText(/cover only what ran/i)).toBeTruthy();
    expect(document.body.textContent ?? "").not.toMatch(/completed/i);
  });

  it("STOPPED says the server lock was lost and what was not started", async () => {
    h.runCycle.mockReturnValue(
      Promise.resolve(
        response({
          completion: completion({ status: "STOPPED", stopReason: "LEASE_LOST", decisionsNotStarted: 2, protectiveNotRun: 1 }),
        }),
      ),
    );
    renderTab();
    startRun();
    await advance(0);
    expect(txt(announce())).toMatch(/stopped before finishing/i);
    const region = within(screen.getByRole("region", { name: /did not finish/i }));
    const text = region.getByText(/lost its server lock/i).textContent ?? "";
    expect(text).toMatch(/2 decisions not started/);
    expect(text).toMatch(/1 protective candidate not run \(nothing sent for them\)/);
    expect(text).toMatch(/sent nothing after the stop/);
  });
});

describe("run autonomous cycle: errors that leave the outcome open", () => {
  it.each([
    ["a dropped connection", () => new TypeError("Failed to fetch")],
    ["a gateway timeout", () => Object.assign(new Error("HTTP 504 Gateway Timeout"), { status: 504 })],
  ])("after %s, says the cycle may still be running on the server", async (_label, makeError) => {
    h.runCycle.mockImplementation(() => Promise.reject(makeError()));
    renderTab();
    startRun();
    await advance(0);
    const text = document.body.textContent ?? "";
    expect(text).toMatch(/may still be running on the server/i);
    expect(text).toMatch(/may still send protective actions to the EA/i);
    expect(text).toMatch(/execution feed/i);
    expect(text).not.toMatch(/no result was returned/i);
    expect(screen.queryByText(/sent to EA — awaiting/i)).toBeNull();
  });

  it("a 409 says another cycle is still running and this one was not started", async () => {
    h.runCycle.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error("HTTP 409 Conflict: An autonomous cycle started 12 s ago is still running on the server"), {
          status: 409,
        }),
      ),
    );
    renderTab();
    startRun();
    await advance(0);
    expect(txt(status())).toMatch(/another cycle is still running/i);
    expect(txt(status())).toMatch(/not started/i);
  });
});

describe("run autonomous cycle: survives leaving and returning to the tab", () => {
  it("keeps the waiting state, the elapsed count and the disabled Run button across a remount, then shows that run's holds", async () => {
    const d = deferred<RunAutonomousCycleResp>();
    h.runCycle.mockReturnValue(d.promise);
    const view = renderTab();
    const invalidate = vi.spyOn(view.client, "invalidateQueries");
    startRun();
    await advance(8_000);
    view.switchAway();
    expect(screen.queryByTestId("run-cycle-status")).toBeNull();
    await advance(4_000);
    view.switchBack();
    // Same render as the remount: still running, counted from the original click.
    expect(txt(status())).toMatch(/cycle running — 12 s elapsed/i);
    expect(blocked(runButton())).toBe(true);
    expect(txt(runButton())).toMatch(/running cycle/i);
    fireEvent.change(cycleReason(), { target: { value: "second run attempt" } });
    fireEvent.click(runButton());
    expect(h.runCycle).toHaveBeenCalledTimes(1);
    await advance(10_000);
    expect(txt(status())).toMatch(/22 s elapsed/);

    d.resolve(response());
    await advance(0);
    expect(txt(status())).toMatch(/cycle finished/i);
    const holds = within(screen.getByRole("list", { name: /hold reasons/i }));
    expect(holds.getByText(TIMEOUT_TEXT)).toBeTruthy();
    expect(screen.getByText(/sent to EA — awaiting broker confirmation 2/i)).toBeTruthy();
    expect(invalidate).toHaveBeenCalled();
  });

  it("shows the result of a run that finished while the tab was away", async () => {
    const d = deferred<RunAutonomousCycleResp>();
    h.runCycle.mockReturnValue(d.promise);
    const view = renderTab();
    const invalidate = vi.spyOn(view.client, "invalidateQueries");
    startRun();
    await advance(3_000);
    view.switchAway();
    d.resolve(response());
    await advance(17_000);
    expect(invalidate).toHaveBeenCalled();
    view.switchBack();
    expect(txt(status())).toMatch(/cycle finished/i);
    expect(txt(status())).not.toMatch(/elapsed/);
    const holds = within(screen.getByRole("list", { name: /hold reasons/i }));
    expect(holds.getByText("PROTECTIVE_HOLD_NO_FRESH_SWEEP")).toBeTruthy();
    expect(holds.getByText(TIMEOUT_TEXT)).toBeTruthy();
    expect(blocked(runButton())).toBe(true); // reason is empty, not running
    expect(txt(runButton())).toMatch(/^run cycle$/i);
  });
});

describe("run autonomous cycle: offline browser", () => {
  it.each([
    ["TanStack's onlineManager is offline", () => onlineManager.setOnline(false)],
    ["navigator.onLine is false", () => vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)],
  ])("when %s, the click sends nothing, says so, and nothing is sent later", async (_label, goOffline) => {
    h.runCycle.mockReturnValue(Promise.resolve(response()));
    renderTab();
    goOffline();
    startRun();
    expect(h.runCycle).not.toHaveBeenCalled();
    expect(txt(announce())).toMatch(/not sent: this browser is offline/i);
    expect(txt(announce())).toMatch(/no cycle was started on the server/i);
    expect(txt(status())).not.toMatch(/cycle running|elapsed/i);
    expect(blocked(runButton())).toBe(false);
    await advance(60_000);
    expect(txt(status())).not.toMatch(/cycle running|elapsed|has not answered/i);
    // Coming back online must not replay the click.
    onlineManager.setOnline(true);
    vi.restoreAllMocks();
    await advance(5_000);
    expect(h.runCycle).not.toHaveBeenCalled();
    // A fresh click once online does send.
    fireEvent.click(runButton());
    await advance(0);
    expect(h.runCycle).toHaveBeenCalledTimes(1);
    expect(txt(announce())).toMatch(/cycle finished/i);
    expect(txt(announce())).not.toMatch(/offline/i);
  });

  it("a run that started online is never paused if the browser goes offline mid-run", async () => {
    const d = deferred<RunAutonomousCycleResp>();
    h.runCycle.mockReturnValue(d.promise);
    renderTab();
    startRun();
    await advance(0);
    expect(h.runCycle).toHaveBeenCalledTimes(1);
    onlineManager.setOnline(false);
    await advance(1_000);
    expect(txt(status())).toMatch(/cycle running — 1 s elapsed/i);
    d.reject(new TypeError("Failed to fetch"));
    await advance(0);
    expect(txt(announce())).toMatch(/may still be running/i);
    expect(txt(status())).not.toMatch(/elapsed/);
  });
});

describe("run autonomous cycle: screen-reader announcements and focus", () => {
  it("announces state changes only, never the per-second counter", async () => {
    const d = deferred<RunAutonomousCycleResp>();
    h.runCycle.mockReturnValue(d.promise);
    renderTab();
    startRun();
    const counter = screen.getByTestId("run-cycle-elapsed");
    expect(announce().contains(counter)).toBe(false);
    await advance(1_000);
    const early = announce().innerHTML;
    await advance(18_000);
    expect(txt(counter)).toMatch(/19 s elapsed/);
    expect(announce().innerHTML).toBe(early);
    await advance(1_000);
    expect(txt(announce())).toMatch(/still running after 20 s/i);
    const mid = announce().innerHTML;
    await advance(25_000);
    expect(announce().innerHTML).toBe(mid);
    await advance(1_000);
    expect(txt(announce())).toMatch(/taking longer than expected/i);
    const late = announce().innerHTML;
    await advance(10_000);
    expect(announce().innerHTML).toBe(late);
    d.resolve(response());
    await advance(0);
    expect(txt(announce())).toMatch(/cycle finished/i);
  });

  it("puts the server's error detail inside the live region", async () => {
    h.runCycle.mockImplementation(() =>
      Promise.reject(Object.assign(new Error("HTTP 409 Conflict: started 12 s ago, still running"), { status: 409 })),
    );
    renderTab();
    startRun();
    await advance(0);
    expect(txt(announce())).toMatch(/started 12 s ago, still running/);
  });

  it("keeps keyboard focus on Run through the run and after it settles", async () => {
    const d = deferred<RunAutonomousCycleResp>();
    h.runCycle.mockReturnValue(d.promise);
    renderTab();
    fireEvent.change(cycleReason(), { target: { value: "qa focus" } });
    runButton().focus();
    fireEvent.click(runButton());
    expect(document.activeElement).toBe(runButton());
    expect(runButton().hasAttribute("disabled")).toBe(false);
    // Enter / click while blocked does nothing.
    fireEvent.click(runButton());
    await advance(0);
    expect(h.runCycle).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(runButton());
    d.resolve(response());
    await advance(0);
    expect(document.activeElement).toBe(runButton());
    expect(runButton().hasAttribute("disabled")).toBe(false);
    expect(blocked(runButton())).toBe(true); // reason cleared
  });
});

describe("run autonomous cycle: settled result age and lifetime", () => {
  it("shows when the run finished, and keeps the result past the default 5 min mutation GC", async () => {
    const d = deferred<RunAutonomousCycleResp>();
    h.runCycle.mockReturnValue(d.promise);
    const view = renderTab();
    startRun();
    await advance(20_000);
    d.resolve(response());
    await advance(0);
    const finishedAt = new Date("2026-10-28T04:00:20Z");
    const hhmmss = [finishedAt.getHours(), finishedAt.getMinutes(), finishedAt.getSeconds()]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
    expect(txt(announce())).toContain(`Cycle finished at ${hhmmss}; results below.`);
    expect(txt(screen.getByTestId("run-cycle-age"))).toMatch(/result from under a minute ago/i);

    view.switchAway();
    await advance(4 * 60_000);
    view.switchBack();
    expect(txt(announce())).toContain(`Cycle finished at ${hhmmss}`);
    expect(txt(screen.getByTestId("run-cycle-age"))).toMatch(/result from 4 min ago/i);
    // The age ticks outside the live region.
    expect(announce().contains(screen.getByTestId("run-cycle-age"))).toBe(false);

    await advance(10 * 60_000);
    expect(txt(screen.getByTestId("run-cycle-age"))).toMatch(/result from 14 min ago/i);
    expect(screen.getByRole("list", { name: /hold reasons/i })).toBeTruthy();
  });
});

describe("run autonomous cycle: unreadable success body", () => {
  it("a 2xx whose body could not be parsed says the cycle ran, not that the request failed", async () => {
    h.runCycle.mockImplementation(() =>
      Promise.reject(
        Object.assign(new Error("Failed to parse response from POST /api/... (200 OK) as JSON"), {
          name: "ResponseParseError",
          status: 200,
        }),
      ),
    );
    renderTab();
    startRun();
    await advance(0);
    const text = txt(announce());
    expect(text).toMatch(/answered .*could not be read/i);
    expect(text).toMatch(/the cycle ran/i);
    expect(text).toMatch(/execution feed/i);
    expect(text).not.toMatch(/request failed/i);
  });
});

describe("run autonomous cycle: elapsed counter is aligned to the click", () => {
  it("after a remount the counter turns over on the original click's whole seconds", async () => {
    const d = deferred<RunAutonomousCycleResp>();
    h.runCycle.mockReturnValue(d.promise);
    const view = renderTab();
    startRun();
    await advance(5_300);
    view.switchAway();
    await advance(7_000); // 12.3 s since the click
    view.switchBack();
    expect(txt(screen.getByTestId("run-cycle-elapsed"))).toMatch(/12 s elapsed/);
    await advance(700); // 13.0 s
    expect(txt(screen.getByTestId("run-cycle-elapsed"))).toMatch(/13 s elapsed/);
    await advance(1_000); // 14.0 s
    expect(txt(screen.getByTestId("run-cycle-elapsed"))).toMatch(/14 s elapsed/);
    d.resolve(response());
    await advance(0);
  });
});
