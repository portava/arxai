import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { ReasonDialog, MaskedValue } from "./cockpitShared";

/**
 * Admin Cockpit — operator-control UI interaction proof.
 *
 * The DB-backed route suite
 * (artifacts/api-server: test:admin-cockpit-route) already locks the SERVER
 * half against a real database: a mutation with a missing/short reason is
 * refused with 400 before any write, broker-sensitive values are returned to
 * OWNER and masked to null for ADMIN, and every write mirrors an
 * admin_cockpit_audit_log row. The cockpit render proof (cockpit.render.test)
 * locks the AdminDiagnosticsGate (admin renders / non-admin + preview-as-user
 * blocked).
 *
 * What was NOT yet covered by a committed test is the BROWSER/UI behaviour of
 * the two shared operator-control primitives — exactly the surface a browser
 * e2e would exercise:
 *
 *   1. ReasonDialog — the confirm dialog appears when open, its Confirm button
 *      is DISABLED until the reason has >= minLen (default 3) NON-WHITESPACE
 *      characters, and on confirm it hands back the TRIMMED reason. This is the
 *      client-side mirror of the server's >= 3 char rule, so an operator can
 *      never even fire the audited mutation without a real reason.
 *   2. MaskedValue — renders the honest OWNER-only masked placeholder when the
 *      server says masked, and the real value otherwise. This is the rendering
 *      half of the OWNER-vs-ADMIN masking the route suite proves server-side.
 *
 * These are pure presentational primitives (no network, no providers), so the
 * proof is deterministic.
 */

afterEach(() => cleanup());

describe("ReasonDialog — reason capture before an audited write", () => {
  it("renders the dialog when open and disables Confirm with an empty reason", () => {
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Freeze investor"
        onConfirm={() => {}}
      />,
    );
    expect(screen.getByTestId("cockpit-reason-dialog")).toBeTruthy();
    expect(screen.getByTestId("cockpit-reason-input")).toBeTruthy();
    const confirm = screen.getByTestId("cockpit-reason-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it("keeps Confirm disabled below minLen, enables at >= minLen, and confirms the trimmed reason", () => {
    const onConfirm = vi.fn();
    render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Freeze investor"
        confirmLabel="Freeze"
        onConfirm={onConfirm}
      />,
    );
    const input = screen.getByTestId("cockpit-reason-input") as HTMLTextAreaElement;
    const confirm = screen.getByTestId("cockpit-reason-confirm") as HTMLButtonElement;

    // 2 visible characters — still below the default 3-char minimum.
    fireEvent.change(input, { target: { value: "ab" } });
    expect(confirm.disabled).toBe(true);

    // 3 characters of whitespace padding around 1 real char — trim() < 3, so
    // raw length must NOT satisfy the gate (proves it counts trimmed length).
    fireEvent.change(input, { target: { value: "  a  " } });
    expect(confirm.disabled).toBe(true);

    // A genuine >= 3 char reason (with padding) — enabled, and onConfirm gets
    // the TRIMMED value.
    fireEvent.change(input, { target: { value: "  freeze it  " } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("freeze it");
  });

  it("honours a custom minLen and stays disabled while busy", () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Approve"
        minLen={5}
        onConfirm={onConfirm}
      />,
    );
    const input = screen.getByTestId("cockpit-reason-input") as HTMLTextAreaElement;
    let confirm = screen.getByTestId("cockpit-reason-confirm") as HTMLButtonElement;

    fireEvent.change(input, { target: { value: "four" } }); // 4 < 5
    expect(confirm.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "fives" } }); // 5 >= 5
    expect(confirm.disabled).toBe(false);

    // While a mutation is in flight (busy), Confirm is disabled even with a
    // valid reason, so a write can never be double-fired.
    rerender(
      <ReasonDialog
        open
        onOpenChange={() => {}}
        title="Approve"
        minLen={5}
        busy
        onConfirm={onConfirm}
      />,
    );
    confirm = screen.getByTestId("cockpit-reason-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });
});

describe("MaskedValue — OWNER-only broker value rendering", () => {
  it("renders the honest masked placeholder for a non-OWNER (masked) value", () => {
    render(<MaskedValue value="98765432" masked />);
    const masked = screen.getByTestId("cockpit-masked");
    expect(masked).toBeTruthy();
    expect(masked.getAttribute("title")).toMatch(/owner/i);
    // The real value must NOT leak into the masked render.
    expect(screen.queryByText("98765432")).toBeNull();
  });

  it("renders the real value for OWNER (not masked)", () => {
    render(<MaskedValue value="98765432" masked={false} />);
    expect(screen.getByText("98765432")).toBeTruthy();
    expect(screen.queryByTestId("cockpit-masked")).toBeNull();
  });

  it("treats null/undefined masked as not masked (no fabricated placeholder)", () => {
    const { rerender } = render(<MaskedValue value="5000" masked={null} />);
    expect(screen.getByText("5000")).toBeTruthy();
    expect(screen.queryByTestId("cockpit-masked")).toBeNull();

    rerender(<MaskedValue value="5000" masked={undefined} />);
    expect(screen.getByText("5000")).toBeTruthy();
    expect(screen.queryByTestId("cockpit-masked")).toBeNull();
  });
});
