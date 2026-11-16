import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// One snapshot per MarketTimingRead entryPermission value.
const PERMISSIONS = ["GO", "WAIT_FOR_ENTRY", "WAIT_NEWS", "NO_TRADE", "STAND_DOWN"] as const;
const snapshots = PERMISSIONS.map((entryPermission, i) => ({
  id: i + 1, symbol: "EURUSD", timeframe: "M15", generatedAt: "2026-10-28T10:00:00.000Z",
  timingGrade: "B", entryPermission, heatScore: 50, tradeabilityScore: 50, dangerScore: 20, bestAction: "WAIT",
}));

vi.mock("@workspace/api-client-react", () => ({
  useListAdminTimingBrainSnapshots: () => ({
    data: { snapshots, hasMore: false, symbols: ["EURUSD"] },
    isLoading: false, isFetching: false, isError: false, refetch: () => undefined,
  }),
  getListAdminTimingBrainSnapshotsQueryKey: () => ["timing-brain"],
}));
vi.mock("@/components/admin/AdminDiagnosticsGate", () => ({
  AdminDiagnosticsGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/admin/HeatRetentionCard", () => ({ HeatRetentionCard: () => null }));

import TimingBrainSnapshotsPage from "./timing-brain-snapshots";

afterEach(() => cleanup());

function permissionBadge(id: number): HTMLElement {
  const row = screen.getByTestId(`row-snapshot-${id}`);
  const badge = within(row).getByText(PERMISSIONS[id - 1]!);
  return badge;
}

describe("Timing Brain snapshots: entry permission badges", () => {
  it("GO (entry permitted) and STAND_DOWN (hard block) get different badges", () => {
    render(<TimingBrainSnapshotsPage />);
    const go = permissionBadge(1).className;
    const standDown = permissionBadge(5).className;
    expect(go).not.toBe(standDown);
    expect(go).toMatch(/bg-primary/);
    expect(standDown).toMatch(/bg-destructive/);
  });

  it("NO_TRADE refuses (destructive); the WAIT states hold (secondary)", () => {
    render(<TimingBrainSnapshotsPage />);
    expect(permissionBadge(4).className).toMatch(/bg-destructive/);
    expect(permissionBadge(2).className).toMatch(/bg-secondary/);
    expect(permissionBadge(3).className).toMatch(/bg-secondary/);
  });
});
