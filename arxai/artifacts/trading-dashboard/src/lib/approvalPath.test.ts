import { describe, it, expect } from "vitest";
import { resolveApprovalPath, type ApprovalPathInput } from "./approvalPath";

// Task #771 — the approval-path resolver must derive an honest status + steps
// purely from the account-mode envelope, never fabricating an approved state and
// never inventing a self-serve unlock (live approval is operator-granted).

function base(overrides: Partial<ApprovalPathInput> = {}): ApprovalPathInput {
  return {
    isLiveShared: false,
    userApprovalStatus: "NOT_REQUIRED",
    tradingMode: "DEMO",
    tradingStatus: "ACTIVE",
    cleanUserMessage: null,
    cleanBlockedReason: null,
    ...overrides,
  };
}

describe("resolveApprovalPath", () => {
  it("LIVE_SHARED ⇒ approved (full menu), regardless of approvalStatus string", () => {
    const v = resolveApprovalPath(base({ isLiveShared: true, userApprovalStatus: "NOT_APPROVED" }));
    expect(v.isApproved).toBe(true);
    expect(v.stage).toBe("APPROVED");
    expect(v.tone).toBe("success");
    // every step done when armed/approved
    expect(v.steps.every((s) => s.done)).toBe(true);
  });

  it("userApprovalStatus APPROVED ⇒ approved even without live-shared/armed", () => {
    const v = resolveApprovalPath(base({ userApprovalStatus: "APPROVED", isLiveShared: false }));
    expect(v.isApproved).toBe(true);
    expect(v.stage).toBe("APPROVED");
    // activation step not yet done (not armed) — honest progression
    expect(v.steps.find((s) => s.key === "activated")?.done).toBe(false);
    expect(v.steps.find((s) => s.key === "approved")?.done).toBe(true);
  });

  it("NOT_APPROVED + SHARED_MASTER waiting ⇒ WAITING_APPROVAL (warning)", () => {
    const v = resolveApprovalPath(
      base({ userApprovalStatus: "NOT_APPROVED", tradingMode: "LIVE", tradingStatus: "WAITING_APPROVAL" }),
    );
    expect(v.isApproved).toBe(false);
    expect(v.stage).toBe("WAITING_APPROVAL");
    expect(v.tone).toBe("warning");
    expect(v.steps.find((s) => s.key === "approved")?.done).toBe(false);
    // enabled step done (tradingMode is LIVE, not DISABLED)
    expect(v.steps.find((s) => s.key === "enabled")?.done).toBe(true);
  });

  it("tradingMode DISABLED ⇒ TRADING_DISABLED, enabled step not done", () => {
    const v = resolveApprovalPath(base({ tradingMode: "DISABLED", userApprovalStatus: "NOT_REQUIRED" }));
    expect(v.stage).toBe("TRADING_DISABLED");
    expect(v.tone).toBe("warning");
    expect(v.steps.find((s) => s.key === "enabled")?.done).toBe(false);
  });

  it("SUSPENDED / DISABLED approval ⇒ on-hold (danger)", () => {
    for (const status of ["SUSPENDED", "DISABLED"]) {
      const v = resolveApprovalPath(base({ userApprovalStatus: status }));
      expect(v.stage, status).toBe("SUSPENDED");
      expect(v.tone, status).toBe("danger");
    }
  });

  it("RISK_LOCKED ⇒ restricted (danger)", () => {
    const v = resolveApprovalPath(base({ userApprovalStatus: "RISK_LOCKED" }));
    expect(v.stage).toBe("RISK_LOCKED");
    expect(v.tone).toBe("danger");
  });

  it("NOT_REQUIRED demo trader ⇒ PRACTICE_ONLY (info)", () => {
    const v = resolveApprovalPath(base({ userApprovalStatus: "NOT_REQUIRED", tradingMode: "DEMO" }));
    expect(v.stage).toBe("PRACTICE_ONLY");
    expect(v.tone).toBe("info");
  });

  it("detail is ONLY ever a server-authored string (block reason preferred, never fabricated)", () => {
    const withBlock = resolveApprovalPath(
      base({ cleanBlockedReason: "Trading is not enabled on your account yet. Contact your operator.", cleanUserMessage: "Demo mode — practice only." }),
    );
    expect(withBlock.detail).toBe("Trading is not enabled on your account yet. Contact your operator.");

    const withMsgOnly = resolveApprovalPath(base({ cleanBlockedReason: null, cleanUserMessage: "Demo mode — practice only." }));
    expect(withMsgOnly.detail).toBe("Demo mode — practice only.");

    const withNothing = resolveApprovalPath(base({ cleanBlockedReason: null, cleanUserMessage: null }));
    expect(withNothing.detail).toBeNull();
  });

  it("guidance never promises a self-serve unlock and points at the operator", () => {
    const v = resolveApprovalPath(base({ userApprovalStatus: "NOT_APPROVED", tradingStatus: "WAITING_APPROVAL" }));
    expect(v.guidance.toLowerCase()).toContain("operator");
    // honesty: it must not claim the user can unlock it themselves
    expect(v.guidance.toLowerCase()).toContain("no self-serve");
  });

  it("distinct inputs produce distinct outputs (not a constant)", () => {
    const a = resolveApprovalPath(base({ userApprovalStatus: "NOT_APPROVED", tradingStatus: "WAITING_APPROVAL" }));
    const b = resolveApprovalPath(base({ userApprovalStatus: "RISK_LOCKED" }));
    expect(a.stage).not.toBe(b.stage);
    expect(a.tone).not.toBe(b.tone);
    expect(a.statusLabel).not.toBe(b.statusLabel);
  });

  it("always exposes exactly the three-step progression in order", () => {
    const v = resolveApprovalPath(base());
    expect(v.steps.map((s) => s.key)).toEqual(["enabled", "approved", "activated"]);
  });
});
