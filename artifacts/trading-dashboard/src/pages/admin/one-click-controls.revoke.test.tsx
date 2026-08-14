import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { OneClickControlsContent } from "./one-click-controls";

/**
 * Task #746 — the admin embedded OneClickControlsContent (mounted on
 * master-bridge.tsx via `<OneClickControlsContent embedded />`) can revoke a
 * permitted user, and the revoke surfaces the server's auto-disarm result.
 *
 * The data + mutation hooks are mocked, so this is a pure render proof of the
 * admin-disable gesture: enter a reason, click Revoke, and assert the revoke
 * mutation is called with the user + reason and the auto-disarm toast appears.
 */

const mockRevoke = vi.fn();
const mockGrant = vi.fn();
const mockRefetch = vi.fn();
const mockToast = vi.fn();

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mockToast }) }));
// OneClickControlsContent does not render the gate itself (only the default page
// export wraps it), but the module imports it — passthrough keeps it inert.
vi.mock("@/components/admin/AdminDiagnosticsGate", () => ({
  AdminDiagnosticsGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const permittedUser = {
  userId: 42,
  email: "trader@example.com",
  name: "Test Trader",
  masterLiveStatus: "APPROVED",
  approvedForMasterLive: true,
  sharedBridgeOneClickPermitted: true,
  sharedBridgeOneClickPermittedAt: "2026-01-01T00:00:00.000Z",
  sharedBridgeOneClickRevokedAt: null,
  oneClickArmed: true,
  oneClickArmedAt: "2026-01-02T00:00:00.000Z",
  oneClickBridgeType: "SHARED",
  lastAuditAction: "ENABLE_LIVE",
  lastAuditAt: "2026-01-02T00:00:00.000Z",
  lastAuditMetadata: null,
};

vi.mock("@workspace/api-client-react", () => ({
  useGetAdminOneClickSharedBridgeUsers: () => ({
    data: { ok: true, isSharedMode: true, users: [permittedUser] },
    isLoading: false,
    isError: false,
    error: null,
    refetch: mockRefetch,
  }),
  usePostAdminOneClickUsersGrant: () => ({ mutateAsync: mockGrant, isPending: false }),
  usePostAdminOneClickUsersRevoke: () => ({ mutateAsync: mockRevoke, isPending: false }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe("OneClickControlsContent (embedded) — admin revoke + auto-disarm", () => {
  it("renders the permitted, armed user with a Revoke control", () => {
    render(<OneClickControlsContent embedded />);
    expect(screen.getByText("trader@example.com")).toBeTruthy();
    expect(screen.getByText("ARMED")).toBeTruthy();
    expect(screen.getByText("Permitted")).toBeTruthy();
    expect(screen.getByRole("button", { name: /revoke/i })).toBeTruthy();
  });

  it("revokes with the entered reason and surfaces the server auto-disarm result", async () => {
    mockRevoke.mockResolvedValueOnce({
      ok: true,
      userId: 42,
      sharedBridgeOneClickPermitted: false,
      autoDisarmed: true,
      revokedAt: "2026-01-03T00:00:00.000Z",
    });

    render(<OneClickControlsContent embedded />);

    fireEvent.change(screen.getByPlaceholderText("Enter reason…"), {
      target: { value: "operator off-boarding" },
    });
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    await waitFor(() => {
      expect(mockRevoke).toHaveBeenCalledWith({
        userId: 42,
        data: { reason: "operator off-boarding" },
      });
    });

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "One-click permission revoked",
          description: "User was also disarmed.",
        }),
      );
    });
    expect(mockRefetch).toHaveBeenCalled();
  });

  it("refuses to revoke without a reason (min 3 chars) and never calls the mutation", async () => {
    render(<OneClickControlsContent embedded />);

    fireEvent.change(screen.getByPlaceholderText("Enter reason…"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Reason required", variant: "destructive" }),
      );
    });
    expect(mockRevoke).not.toHaveBeenCalled();
  });
});
