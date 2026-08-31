// CONFIDENT_ABSENT — the first-run welcome modal's "Risk Controls" chip.
//
// The chip read `isFrozen ? "Lock active" : "Active"` with no
// envelope-loaded guard. `isFrozen` is derived as
// `env?.userFrozenStatus.isFrozen === true` (useTradingMode), i.e. false
// whenever the account-mode envelope is null or its read failed — so a
// failed /api/me/account-mode fetch rendered a green "Risk Controls:
// Active", asserting a safety control was running when its state was
// unknown. The approval and bridge chips beside it already degraded to
// "Checking"; this locks the same honesty onto the risk chip.

import { describe, it, expect } from "vitest";
import { deriveRiskChip } from "./OnboardingProvider";

describe("welcome-modal Risk Controls chip tells the truth about unknown state", () => {
  it("unloaded/failed envelope → 'Checking', never a confident 'Active'", () => {
    // isFrozen is false when env is null — exactly the case that used to lie.
    expect(deriveRiskChip(false, false)).toEqual({ label: "Checking", tone: "muted" });
  });

  it("an unloaded envelope wins even if a stale isFrozen=true were passed", () => {
    expect(deriveRiskChip(false, true)).toEqual({ label: "Checking", tone: "muted" });
  });

  it("loaded + frozen → 'Lock active'", () => {
    expect(deriveRiskChip(true, true)).toEqual({ label: "Lock active", tone: "danger" });
  });

  it("loaded + not frozen → 'Active' (the only case that may claim it)", () => {
    expect(deriveRiskChip(true, false)).toEqual({ label: "Active", tone: "success" });
  });
});
