import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAllocationGate, type AllocationGateView } from "../allocationGate";

// Offline unit proof for the per-user live-allocation gate decision. This is the
// pure half of the fix for the "Cockpit shows headroom but live submit blocks"
// mismatch: the gate refuses on the SAME availableAllocation the card displays,
// and distinguishes "no allocation assigned" from "headroom exhausted". TRUE-zero
// and not-assigned must ALWAYS block — the split only changes the copy.

function view(over: Partial<AllocationGateView>): AllocationGateView {
  return {
    assignedAllocation: 0,
    availableAllocation: 0,
    reservedRisk: 0,
    openFloatingLoss: 0,
    hasAllocation: false,
    ...over,
  };
}

describe("resolveAllocationGate", () => {
  it("blocks NOT_ASSIGNED when no allocation row / assigned 0", () => {
    const r = resolveAllocationGate(view({ hasAllocation: false, assignedAllocation: 0 }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "LIVE_BLOCKED:USER_ALLOCATION_NOT_ASSIGNED");
    // never tells a user-with-no-allocation it was "exhausted by floating loss"
    assert.match(r.ok === false ? r.detail : "", /assigned 0\.00/);
    assert.doesNotMatch(r.ok === false ? r.detail : "", /floating loss/i);
  });

  it("blocks EXHAUSTED when assigned > 0 but available <= 0 (consumed by reserved + floating loss)", () => {
    const r = resolveAllocationGate(view({
      hasAllocation: true,
      assignedAllocation: 181.58,
      reservedRisk: 0,
      openFloatingLoss: -86.73,
      // assigned 181.58 − reserved 0 + floating −181.58 floored = 0 headroom
      availableAllocation: 0,
    }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "LIVE_BLOCKED:USER_ALLOCATION_EXHAUSTED");
    // admin breakdown carries the full math
    const detail = r.ok === false ? r.detail : "";
    assert.match(detail, /assigned 181\.58/);
    assert.match(detail, /reserved 0\.00/);
    assert.match(detail, /floating loss -86\.73/);
  });

  it("passes (allocation is NOT the blocker) when assigned > 0 and available > 0", () => {
    const r = resolveAllocationGate(view({
      hasAllocation: true,
      assignedAllocation: 200,
      reservedRisk: 10,
      openFloatingLoss: 0,
      availableAllocation: 190,
    }));
    assert.equal(r.ok, true);
  });

  it("treats hasAllocation=false as NOT_ASSIGNED even if availableAllocation is somehow > 0", () => {
    // hasAllocation is the authoritative 'row exists AND assigned>0' flag; it
    // wins over a stray positive available so we never imply an allocation that
    // does not exist.
    const r = resolveAllocationGate(view({ hasAllocation: false, assignedAllocation: 0, availableAllocation: 50 }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "LIVE_BLOCKED:USER_ALLOCATION_NOT_ASSIGNED");
  });
});
