import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { WeeklyStoryReport } from "./investor";
import type {
  WeeklyReportDto,
  WeeklyAccountStory,
} from "@workspace/api-client-react";

/**
 * Frontend smoke for the investor "Weekly Account Story" tab (Task #145 QA
 * proof layer). WeeklyStoryReport is the presentational renderer for a single
 * published WeeklyReportDto; the backend already redacts the payload (proven by
 * fundBookRegressionTest.ts hitting the live endpoints). This test proves the
 * COMPONENT itself:
 *
 *   1. Renders the three honest economic-impact states without crashing:
 *      a verifiable week (net change + decomposition), a starting-baseline week
 *      (no prior week to compare), and a withheld week (values under review).
 *   2. Surfaces under-review / stale freshness honestly.
 *   3. The component's OWN markup/chrome introduces no forbidden field labels —
 *      raw broker field names, the ARX internal waterfall split, or trader
 *      compensation. This is a structural property of the renderer, NOT a
 *      payload-redaction proof: the DTO's free-text fields are designed to be
 *      passed through, so the authoritative anti-leak boundary is the BACKEND
 *      (proven by fundBookRegressionTest.ts scanning the real investor
 *      endpoints). This test guards against the renderer ever hard-coding such a
 *      label into its layout.
 *
 * Pure render (no hooks, no network): WeeklyStoryReport takes its report as a
 * prop, so no api-client mocking is required.
 */

const FORBIDDEN_TOKENS = [
  "accountBalance",
  "accountEquity",
  "accountNumber",
  "brokerTicket",
  "arxShare",
  "arxSharePct",
  "arxInternal",
  "internalSplit",
  "traderComp",
  "waterfall",
];

function makeNarrative(overrides: Partial<WeeklyAccountStory> = {}): WeeklyAccountStory {
  return {
    schemaVersion: 1,
    periodKey: "2026-W22",
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-06-08T00:00:00.000Z",
    headline: "Your account moved with the market this week",
    summary: "A plain-language summary derived only from your recorded activity.",
    economicImpact: {
      netChange: 1240.5,
      flows: 1000,
      marketChange: 240.5,
      changeVerifiable: true,
      deposits: 1000,
      withdrawals: 0,
      distributions: 0,
      baselineAvailable: true,
      baselineValue: 50000,
      baselinePeriodKey: "2026-W21",
      endValue: 51240.5,
    },
    pools: [
      {
        poolKey: "CASH_RESERVE",
        name: "Cash Reserve",
        riskLevel: "Conservative",
        settledValue: 50000,
        floatingPlShare: 240.5,
        endValue: 51240.5,
        flowsInWindow: 1000,
        sharePct: 1,
        navStatus: "ACTIVE",
        underReview: false,
      },
    ],
    topPositive: [{ poolKey: "CASH_RESERVE", name: "Cash Reserve", floatingPlShare: 240.5 }],
    topNegative: [],
    risk: { drawdownPercent: 0.012, drawdownUsd: 620, elevated: false },
    depositLock: {
      lockedPrincipal: 1000,
      withdrawableValue: 50240.5,
      nextReleaseAt: "2026-06-30T00:00:00.000Z",
      releasesNextWeek: false,
    },
    watching: [{ kind: "DEPOSIT_LOCK", message: "A deposit lock releases later this month." }],
    dataQuality: {
      navStatus: "ACTIVE",
      freshness: "FRESH",
      freshnessMessage: "",
      baselineAvailable: true,
    },
    disclosures: ["Values reflect your recorded activity only."],
    ...overrides,
  };
}

function makeReport(narrative: WeeklyAccountStory): WeeklyReportDto {
  return {
    id: 1,
    periodKey: narrative.periodKey,
    periodStart: narrative.periodStart,
    periodEnd: narrative.periodEnd,
    version: 1,
    status: "PUBLISHED",
    headline: narrative.headline,
    navStatus: narrative.dataQuality.navStatus,
    freshness: narrative.dataQuality.freshness,
    baselineAvailable: narrative.dataQuality.baselineAvailable,
    publishedAt: "2026-06-08T12:00:00.000Z",
    createdAt: "2026-06-08T12:00:00.000Z",
    narrative,
  };
}

function expectNoForbiddenTokens(html: string): void {
  const leaks = FORBIDDEN_TOKENS.filter((t) =>
    html.toLowerCase().includes(t.toLowerCase()),
  );
  expect(leaks).toEqual([]);
}

afterEach(() => cleanup());

describe("WeeklyStoryReport — honest economic-impact states", () => {
  it("renders a verifiable week with the net-change decomposition", () => {
    const { container } = render(<WeeklyStoryReport report={makeReport(makeNarrative())} />);
    expect(screen.getByTestId("weekly-story-report")).toBeTruthy();
    expect(screen.getByTestId("weekly-economic-impact")).toBeTruthy();
    expect(screen.getByTestId("weekly-pools")).toBeTruthy();
    expect(screen.getByTestId("weekly-watching")).toBeTruthy();
    // Verifiable week must NOT show baseline / withheld notices.
    expect(screen.queryByTestId("weekly-no-baseline")).toBeNull();
    expect(screen.queryByTestId("weekly-change-withheld")).toBeNull();
    expectNoForbiddenTokens(container.innerHTML);
  });

  it("renders the starting-baseline week honestly (no prior week to compare)", () => {
    const narrative = makeNarrative({
      economicImpact: {
        netChange: null,
        flows: 1000,
        marketChange: null,
        changeVerifiable: false,
        deposits: 1000,
        withdrawals: 0,
        distributions: 0,
        baselineAvailable: false,
        baselineValue: null,
        baselinePeriodKey: null,
        endValue: 51000,
      },
      dataQuality: { navStatus: "ACTIVE", freshness: "FRESH", freshnessMessage: "", baselineAvailable: false },
    });
    const { container } = render(<WeeklyStoryReport report={makeReport(narrative)} />);
    expect(screen.getByTestId("weekly-no-baseline")).toBeTruthy();
    expect(screen.queryByTestId("weekly-economic-impact")).toBeNull();
    expectNoForbiddenTokens(container.innerHTML);
  });

  it("renders the withheld + under-review + stale state honestly", () => {
    const narrative = makeNarrative({
      economicImpact: {
        netChange: null,
        flows: 1000,
        marketChange: null,
        changeVerifiable: false,
        deposits: 1000,
        withdrawals: 0,
        distributions: 0,
        baselineAvailable: true,
        baselineValue: 50000,
        baselinePeriodKey: "2026-W21",
        endValue: null,
      },
      dataQuality: {
        navStatus: "UNDER_REVIEW",
        freshness: "STALE",
        freshnessMessage: "Some values are still being verified.",
        baselineAvailable: true,
      },
    });
    const { container } = render(<WeeklyStoryReport report={makeReport(narrative)} />);
    expect(screen.getByTestId("weekly-change-withheld")).toBeTruthy();
    expect(screen.getByTestId("weekly-under-review")).toBeTruthy();
    expect(screen.getByTestId("weekly-quality-note")).toBeTruthy();
    expect(screen.queryByTestId("weekly-economic-impact")).toBeNull();
    expectNoForbiddenTokens(container.innerHTML);
  });
});
