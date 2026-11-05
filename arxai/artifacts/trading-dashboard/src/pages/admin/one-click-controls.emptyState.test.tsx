import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

// The empty list must explain the server's filter. GET
// /admin/one-click/shared-bridge-users returns users:[] whenever routing is
// not SHARED_MASTER_MT5 (isSharedMode:false) or every user in the master live
// access table has an MT5 bridge of their own — it never means "the table is
// empty" by itself.

let reply: { ok: boolean; isSharedMode: boolean; users: unknown[] };

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/admin/AdminDiagnosticsGate", () => ({
  AdminDiagnosticsGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetAdminOneClickSharedBridgeUsers: () => ({
    data: reply, isLoading: false, isError: false, error: null, refetch: vi.fn(),
  }),
  usePostAdminOneClickUsersGrant: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePostAdminOneClickUsersRevoke: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { OneClickControlsContent } from "./one-click-controls";

afterEach(() => cleanup());

describe("OneClickControlsContent — empty list explains the shared-bridge filter", () => {
  it("routing not shared: says no user is listed because routing is not SHARED_MASTER_MT5", () => {
    reply = { ok: true, isSharedMode: false, users: [] };
    render(<OneClickControlsContent embedded />);
    expect(screen.queryByText(/No users in the master live access table yet/)).toBeNull();
    const t = screen.getByTestId("text-one-click-empty").textContent ?? "";
    expect(t).toContain("routing is not");
    expect(t).toContain("SHARED_MASTER_MT5");
  });

  it("routing not shared: claims only what was checked (the platform routing setting), not how every user trades", () => {
    reply = { ok: true, isSharedMode: false, users: [] };
    render(<OneClickControlsContent embedded />);
    const t = screen.getByTestId("text-one-click-empty").textContent ?? "";
    // A per-user accountRoutingOverride of shared_master_mt5 still routes that
    // user through the shared bridge; the server does not check overrides.
    expect(t).not.toMatch(/each user trades through their own MT5\s+bridge/);
    expect(t).not.toMatch(/there are no shared-bridge users/);
    expect(t).toMatch(/platform routing setting/);
    expect(t).toMatch(/per-user routing override/);
    expect(t).toMatch(/no settings row/);
  });

  it("shared routing, nobody listed: says the list excludes users with their own bridge", () => {
    reply = { ok: true, isSharedMode: true, users: [] };
    render(<OneClickControlsContent embedded />);
    expect(screen.queryByText(/No users in the master live access table yet/)).toBeNull();
    const t = screen.getByTestId("text-one-click-empty").textContent ?? "";
    expect(t).toContain("No shared-bridge users");
    expect(t).toContain("no MT5 bridge of their own");
  });
});
