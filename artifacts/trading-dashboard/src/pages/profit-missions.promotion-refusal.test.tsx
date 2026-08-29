// Render proof for the mission-promotion refusal surface.
//
// WHY THIS EXISTS AS A RENDER TEST. The previous guard for this behaviour was
// `expect(src).toContain("authority-grant-blocker-link")` — a grep over
// profit-missions.tsx. It passed green while the JSX it pointed at was
// unreachable code, because the render condition read the ADVISORY gate list
// from GET /profit-missions/:id/promotion, and that list can never mention
// `authority_grant`:
//
//   * resolveMissionPromotionStatus calls evaluateMissionPromotion, which builds
//     exactly ten fixed gates (backtest_sample … live_gates_enabled). No
//     authority read-through runs on the GET path at all.
//   * The authority refusal is appended ONLY on the apply path, into
//     decision.failedGates / decision.blockers.
//   * The refusal is answered HTTP 200 with `applied: false`, so react-query's
//     onSuccess ran and cleared the error — the `error.includes("authority")`
//     fallback was dead too.
//
// A source-text assertion cannot tell a rendered block from dead code. This
// mounts the real component and drives the real server payload through it.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// The ten gates the advisory GET actually returns. None of them is
// `authority_grant` — that is the whole point.
const advisoryGates = [
  { name: "backtest_sample", passed: true, detail: "42 backtested trades" },
  { name: "forward_sample", passed: true, detail: "31 forward trades" },
  { name: "demo_performance", passed: true, detail: "expectancy 0.31R" },
  { name: "max_drawdown", passed: true, detail: "8.2% peak-to-trough" },
  { name: "agent_reliability", passed: true, detail: "no agent below threshold" },
  { name: "risk_rule_compliance", passed: true, detail: "no breaches in window" },
  { name: "no_major_drift", passed: true, detail: "drift NONE" },
  { name: "explicit_user_enablement", passed: true, detail: "not required below level 4" },
  { name: "risk_certificate", passed: true, detail: "accepted" },
  { name: "live_gates_enabled", passed: true, detail: "not required below level 4" },
];

const promotion = {
  currentLevel: 2,
  liveAutoEnabled: false,
  certificateAccepted: true,
  decision: {
    approved: true,
    allowedMaxLevel: 3,
    gates: advisoryGates,
    failedGates: [],
    blockers: [],
  },
  guardrail: { maxLevel: 4 },
  driftSeverity: "NONE",
};

// The exact shape routes/profitMissions.ts answers a refused PATCH with:
// HTTP 200, applied:false, and the decision carrying the appended gate.
const AUTHORITY_REFUSAL = {
  applied: false,
  level: 2,
  liveAutoEnabled: false,
  decision: {
    approved: false,
    allowedMaxLevel: 3,
    gates: advisoryGates,
    failedGates: ["authority_grant"],
    blockers: [
      "authority_grant: raising automation to level 3 requires an active owner-pressed authority grant (current ceiling 2)",
    ],
  },
};

const UNREADABLE_LEDGER_REFUSAL = {
  ...AUTHORITY_REFUSAL,
  decision: {
    ...AUTHORITY_REFUSAL.decision,
    blockers: [
      "authority_grant: the authority ledger could not be read (db_unavailable) — automation increases fail closed",
    ],
  },
};

const OTHER_REFUSAL = {
  applied: false,
  level: 2,
  liveAutoEnabled: false,
  decision: {
    approved: false,
    allowedMaxLevel: 2,
    gates: advisoryGates,
    failedGates: ["forward_sample"],
    blockers: ["forward_sample: 12 forward trades, 30 required"],
  },
};

const APPLIED = {
  applied: true,
  level: 3,
  liveAutoEnabled: false,
  decision: { approved: true, allowedMaxLevel: 3, gates: advisoryGates, failedGates: [], blockers: [] },
};

let applyResponse: unknown = AUTHORITY_REFUSAL;

vi.mock("@workspace/api-client-react", () => {
  // Defined INSIDE the factory: vi.mock is hoisted above module scope, so a
  // top-level helper would not exist yet when this runs.
  const noop = () => ({ mutate: vi.fn(), isPending: false });
  const empty = () => ({ data: undefined, isLoading: false });
  return {
    useListProfitMissions: () => ({ data: [], isLoading: false }),
    useCreateProfitMission: noop,
    usePauseProfitMission: noop,
    useResumeProfitMission: noop,
    useCancelProfitMission: noop,
    useListProfitMissionEvents: () => ({ data: [], isLoading: false }),
    useListMissionAgents: () => ({ data: [], isLoading: false }),
    useListMissionProposals: () => ({ data: [], isLoading: false }),
    useRunMissionScan: noop,
    useListMissionTradeDrafts: () => ({ data: [], isLoading: false }),
    useApproveMissionProposalDraft: noop,
    useRejectMissionProposalDraft: noop,
    useGetProfitMissionPulse: empty,
    useEmergencyStopProfitMission: noop,
    useExecuteMissionProposalDraft: noop,
    useManageMissionTradeExit: noop,
    useRunMissionBacktest: noop,
    useAggregateMissionForward: noop,
    useListMissionTestResults: () => ({ data: { results: [] }, isLoading: false }),
    useGetMissionDrift: empty,
    useGetMissionPromotion: () => ({ data: promotion, isLoading: false }),
    // The one hook under test: mutate() replays the server's real answer through
    // the component's own onSuccess handler.
    useApplyMissionAutomationLevel: (opts?: {
      mutation?: { onSuccess?: (r: unknown, v: unknown, c: unknown) => void };
    }) => ({
      mutate: () => opts?.mutation?.onSuccess?.(applyResponse, { id: 1, data: { level: 3 } }, undefined),
      isPending: false,
    }),
    useGetMissionCertificate: empty,
    useAcceptMissionCertificate: noop,
    useGetMissionBriefing: empty,
    useGetMissionEodReview: empty,
    useGetMissionReport: empty,
    useParseProfitMissionIntent: noop,
    getListProfitMissionsQueryKey: () => ["profit-missions"],
    getListProfitMissionEventsQueryKey: () => ["mission-events", 1],
    getListMissionAgentsQueryKey: () => ["mission-agents", 1],
    getListMissionProposalsQueryKey: () => ["mission-proposals", 1],
    getListMissionTradeDraftsQueryKey: () => ["mission-trade-drafts", 1],
    getGetProfitMissionPulseQueryKey: () => ["mission-pulse", 1],
    getListMissionTestResultsQueryKey: () => ["mission-test-results", 1],
    getGetMissionDriftQueryKey: () => ["mission-drift", 1],
    getGetMissionPromotionQueryKey: () => ["mission-promotion", 1],
    getGetMissionCertificateQueryKey: () => ["mission-certificate", 1],
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { MissionTestingLab } from "./profit-missions";

type LabMission = Parameters<typeof MissionTestingLab>[0]["mission"];
const mission = { id: 1, automationLevel: 2 } as unknown as LabMission;

afterEach(() => {
  cleanup();
  applyResponse = AUTHORITY_REFUSAL;
});

function pressApply() {
  fireEvent.click(screen.getByTestId("button-apply-level"));
}

describe("mission promotion — the authority blocker is reachable, not dead code", () => {
  it("shows no refusal and no authority link before any press", () => {
    render(<MissionTestingLab mission={mission} />);
    // The advisory GET alone must never produce either block. This is the
    // assertion the old source-grep test could not make, and the reason the
    // link was unreachable: nothing in `decision.gates` ever says
    // `authority_grant`.
    expect(screen.queryByTestId("promotion-apply-refusal")).toBeNull();
    expect(screen.queryByTestId("authority-grant-blocker-link")).toBeNull();
  });

  it("renders the authority blocker AND the /authority link after the server refuses on authority_grant", () => {
    render(<MissionTestingLab mission={mission} />);
    pressApply();

    const refusal = screen.getByTestId("promotion-apply-refusal");
    expect(refusal.textContent).toContain("The level was not applied.");
    // The server's blocker string is rendered verbatim — not paraphrased away.
    expect(refusal.textContent).toContain("requires an active owner-pressed authority grant");

    const link = screen.getByTestId("authority-grant-blocker-link");
    expect(link.textContent).toContain("Open Automation Authority");
    const anchor = link.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor!.getAttribute("href")).toBe("/authority");
  });

  it("surfaces a fail-closed unreadable ledger as an authority blocker too", () => {
    applyResponse = UNREADABLE_LEDGER_REFUSAL;
    render(<MissionTestingLab mission={mission} />);
    pressApply();
    expect(screen.getByTestId("promotion-apply-refusal").textContent).toContain(
      "the authority ledger could not be read",
    );
    // An unreadable permission is not a permission: the user is still pointed
    // at the grant surface rather than left with a bare failure.
    expect(screen.getByTestId("authority-grant-blocker-link")).toBeTruthy();
  });

  it("states a non-authority refusal without pointing at the authority press", () => {
    applyResponse = OTHER_REFUSAL;
    render(<MissionTestingLab mission={mission} />);
    pressApply();
    expect(screen.getByTestId("promotion-apply-refusal").textContent).toContain(
      "12 forward trades, 30 required",
    );
    // No false signpost: this refusal has nothing to do with authority.
    expect(screen.queryByTestId("authority-grant-blocker-link")).toBeNull();
  });

  it("never claims a refusal happened when the level was applied", () => {
    applyResponse = APPLIED;
    render(<MissionTestingLab mission={mission} />);
    pressApply();
    expect(screen.queryByTestId("promotion-apply-refusal")).toBeNull();
    expect(screen.queryByTestId("authority-grant-blocker-link")).toBeNull();
  });

  it("says so honestly when the server refuses with no stated reason", () => {
    applyResponse = { applied: false, level: 2, liveAutoEnabled: false, decision: {} };
    render(<MissionTestingLab mission={mission} />);
    pressApply();
    expect(screen.getByTestId("promotion-apply-refusal").textContent).toContain(
      "the server gave no reason",
    );
  });
});
