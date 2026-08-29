// F-build — pure mission-driver planner tests (tick decisions + the
// auto-approve level matrix). IO-free: only the pure domain planner is
// imported, with a FAKE CLOCK passed explicitly, so this runs in the offline
// `ci` lane. The composition worker (missionDriver.ts) is proven separately in
// the DB-backed integration lane (missionDriverWorker.test.ts).
//
// Locked here:
//   * Tick advance with a fake clock: timeframe expiry fires exactly when the
//     clock passes timeframeEnd (never before), and only where the state
//     machine has an `expired` edge.
//   * Goal completion: a reached target plans protective steps only — never
//     new risk.
//   * Stop enforcement: emergency / blow-up stops plan a pause with exits
//     still managed.
//   * Gate-block handling: any failed act-time check yields allowed=false with
//     honest reason codes; nothing is ever "partially allowed".
//   * The auto-approve level matrix: 0–2 never auto-approve; 3 auto-runs only
//     a non-live mission; 4–6 on a live mission require the explicit live-auto
//     opt-in + certificate + promotion re-check + live gates, each fail-closed.
//
// Run: pnpm --filter @workspace/api-server run test:mission-driver-domain

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planMissionTick,
  decideAutoApproval,
  type AutoApprovalInput,
  type MissionTickInput,
} from "@workspace/domain/profit-mission";

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0); // fake clock origin
const HOUR = 60 * 60 * 1000;

function autoInput(over: Partial<AutoApprovalInput> = {}): AutoApprovalInput {
  return {
    automationLevel: 2,
    executionMode: "paper",
    liveAutoEnabled: false,
    certificateAccepted: false,
    promotionApproved: false,
    driftSeverity: "UNKNOWN",
    liveGatesEnabled: false,
    ...over,
  };
}

function tickInput(over: Partial<MissionTickInput> = {}): MissionTickInput {
  return {
    status: "running",
    timeframeEndMs: T0 + 24 * HOUR,
    nowMs: T0,
    targetReached: false,
    emergencyTriggered: false,
    riskStopRequired: false,
    auto: autoInput(),
    ...over,
  };
}

// ── Tick advance with a fake clock ───────────────────────────────────────────

test("fake clock: no expiry one tick BEFORE timeframeEnd, expiry exactly at/after it", () => {
  const end = T0 + 24 * HOUR;
  const before = planMissionTick(tickInput({ timeframeEndMs: end, nowMs: end - 1 }));
  assert.equal(before.action, "advance", "one ms before the end the mission still advances");

  const at = planMissionTick(tickInput({ timeframeEndMs: end, nowMs: end }));
  assert.equal(at.action, "expire");
  assert.ok(at.reasons.includes("TIMEFRAME_ENDED"));
  // Protective steps still run on the expiry tick — an open position is never
  // orphaned unmanaged — but NO new-risk step is planned.
  assert.deepEqual(at.steps, ["manage_exits", "refresh_protection"]);
  assert.equal(at.autoApproval.allowed, false);

  const after = planMissionTick(tickInput({ timeframeEndMs: end, nowMs: end + 12 * HOUR }));
  assert.equal(after.action, "expire", "expiry keeps firing until the transition lands");
});

test("expiry only where the state machine has an expired edge", () => {
  // running / paused / protect_mode all expire…
  for (const status of ["running", "paused", "protect_mode"]) {
    const p = planMissionTick(tickInput({ status, nowMs: T0 + 48 * HOUR }));
    assert.equal(p.action, "expire", `${status} expires`);
  }
  // …draft has no expired edge (draft → expired is not a legal move).
  const draft = planMissionTick(tickInput({ status: "draft", nowMs: T0 + 48 * HOUR }));
  assert.notEqual(draft.action, "expire");
  assert.ok(draft.reasons.includes("TIMEFRAME_ENDED_NO_EXPIRE_EDGE"));
});

test("terminal and unknown statuses are left untouched", () => {
  for (const status of ["completed", "cancelled", "failed", "expired"]) {
    const p = planMissionTick(tickInput({ status }));
    assert.equal(p.action, "none");
    assert.deepEqual(p.steps, []);
  }
  const unknown = planMissionTick(tickInput({ status: "definitely-not-a-status" }));
  assert.equal(unknown.action, "none");
  assert.ok(unknown.reasons.includes("UNKNOWN_STATUS"));
});

// ── Goal completion ──────────────────────────────────────────────────────────

test("goal completion: a reached target plans protective steps only — never new risk", () => {
  // Even a fully-auto-eligible live mission stops planning new risk at target.
  const p = planMissionTick(
    tickInput({
      targetReached: true,
      auto: autoInput({
        automationLevel: 6,
        executionMode: "live",
        liveAutoEnabled: true,
        certificateAccepted: true,
        promotionApproved: true,
        driftSeverity: "NONE",
        liveGatesEnabled: true,
      }),
    }),
  );
  assert.equal(p.action, "advance");
  assert.deepEqual(p.steps, ["manage_exits", "refresh_protection"]);
  assert.equal(p.autoApproval.allowed, false);
  assert.ok(p.reasons.includes("TARGET_REACHED"));
});

// ── Stop enforcement ─────────────────────────────────────────────────────────

test("stop enforcement: emergency and blow-up stops plan a pause with exits still managed", () => {
  const emergency = planMissionTick(tickInput({ emergencyTriggered: true }));
  assert.equal(emergency.action, "pause");
  assert.deepEqual(emergency.steps, ["manage_exits", "refresh_protection"]);
  assert.ok(emergency.reasons.includes("EMERGENCY_STOP"));
  assert.equal(emergency.autoApproval.allowed, false);

  const blowup = planMissionTick(tickInput({ riskStopRequired: true }));
  assert.equal(blowup.action, "pause");
  assert.ok(blowup.reasons.includes("RISK_STOP_REQUIRED"));
});

test("a paused mission gets its status kept honest but never new risk", () => {
  const p = planMissionTick(
    tickInput({
      status: "paused",
      auto: autoInput({ automationLevel: 3, executionMode: "demo", promotionApproved: true, driftSeverity: "NONE" }),
    }),
  );
  assert.equal(p.action, "advance");
  assert.deepEqual(p.steps, ["refresh_protection"]);
  assert.equal(p.autoApproval.allowed, false);
});

// ── Auto-approve level matrix ────────────────────────────────────────────────

test("levels 0-2 never auto-approve (the user's press IS the approval)", () => {
  for (const level of [0, 1, 2]) {
    for (const mode of ["paper", "demo", "live"]) {
      const d = decideAutoApproval(
        autoInput({
          automationLevel: level,
          executionMode: mode,
          liveAutoEnabled: true,
          certificateAccepted: true,
          promotionApproved: true,
          driftSeverity: "NONE",
          liveGatesEnabled: true,
        }),
      );
      assert.equal(d.allowed, false, `level ${level} / ${mode} must not auto-approve`);
      assert.ok(d.blockReasons.includes("LEVEL_REQUIRES_USER_APPROVAL"));
    }
  }
});

test("level 3 (demo auto): auto-runs only a NON-live mission", () => {
  for (const mode of ["paper", "demo"] as const) {
    const d = decideAutoApproval(
      autoInput({ automationLevel: 3, executionMode: mode, promotionApproved: true, driftSeverity: "NONE" }),
    );
    assert.equal(d.allowed, true, `level 3 / ${mode} auto-approves`);
    assert.equal(d.reachesLive, false, "level 3 can never feed a live dispatch");
  }
  const live = decideAutoApproval(
    autoInput({ automationLevel: 3, executionMode: "live", promotionApproved: true, driftSeverity: "NONE" }),
  );
  assert.equal(live.allowed, false);
  assert.ok(live.blockReasons.includes("DEMO_AUTO_CANNOT_DRIVE_LIVE_MISSION"));
});

test("levels 4-6 live: every live gate is required, each fail-closed on its own", () => {
  const allOn = (level: number) =>
    autoInput({
      automationLevel: level,
      executionMode: "live",
      liveAutoEnabled: true,
      certificateAccepted: true,
      promotionApproved: true,
      driftSeverity: "NONE",
      liveGatesEnabled: true,
    });

  for (const level of [4, 5, 6]) {
    // With everything on, live auto is allowed and marked live-reaching.
    const ok = decideAutoApproval(allOn(level));
    assert.equal(ok.allowed, true, `level ${level} all-gates-on allows`);
    assert.equal(ok.reachesLive, true);

    // Removing ANY single requirement refuses with its precise reason.
    const cases: Array<[Partial<AutoApprovalInput>, string]> = [
      [{ liveAutoEnabled: false }, "LIVE_AUTO_NOT_ENABLED"],
      [{ certificateAccepted: false }, "CERTIFICATE_NOT_ACCEPTED"],
      [{ promotionApproved: false }, "PROMOTION_GATE_NOT_APPROVED"],
      [{ liveGatesEnabled: false }, "LIVE_GATES_DISABLED"],
      [{ driftSeverity: "SEVERE" }, "SEVERE_DRIFT"],
    ];
    for (const [override, reason] of cases) {
      const d = decideAutoApproval({ ...allOn(level), ...override });
      assert.equal(d.allowed, false, `level ${level}: missing ${reason} refuses`);
      assert.equal(d.reachesLive, false);
      assert.ok(d.blockReasons.includes(reason), `level ${level} reports ${reason}`);
    }
  }
});

test("levels 4-6 on a non-live mission auto-run without the live-only gates", () => {
  // A live-auto level running a demo-mode mission is stricter than its level
  // permits — allowed, and never live-reaching.
  const d = decideAutoApproval(
    autoInput({ automationLevel: 5, executionMode: "demo", promotionApproved: true, driftSeverity: "NONE" }),
  );
  assert.equal(d.allowed, true);
  assert.equal(d.reachesLive, false);
});

test("gate-block handling: unknown level/mode and SEVERE drift fail closed with honest reasons", () => {
  const unknownLevel = decideAutoApproval(autoInput({ automationLevel: 42 }));
  assert.equal(unknownLevel.allowed, false);
  assert.ok(unknownLevel.blockReasons.includes("UNKNOWN_AUTOMATION_LEVEL"));

  const unknownMode = decideAutoApproval(autoInput({ automationLevel: 3, executionMode: "hyperspace" }));
  assert.equal(unknownMode.allowed, false);
  assert.ok(unknownMode.blockReasons.includes("UNKNOWN_EXECUTION_MODE"));

  const drift = decideAutoApproval(
    autoInput({ automationLevel: 3, executionMode: "demo", promotionApproved: true, driftSeverity: "SEVERE" }),
  );
  assert.equal(drift.allowed, false);
  assert.ok(drift.blockReasons.includes("SEVERE_DRIFT"));
});

test("a blocked auto decision surfaces its reasons on the tick plan (nothing partial)", () => {
  const p = planMissionTick(
    tickInput({
      auto: autoInput({ automationLevel: 5, executionMode: "live", promotionApproved: true, driftSeverity: "NONE" }),
    }),
  );
  assert.equal(p.action, "advance");
  // Protective steps stay; the auto steps are entirely absent.
  assert.deepEqual(p.steps, ["manage_exits", "refresh_protection"]);
  assert.equal(p.autoApproval.allowed, false);
  for (const reason of ["LIVE_AUTO_NOT_ENABLED", "CERTIFICATE_NOT_ACCEPTED", "LIVE_GATES_DISABLED"]) {
    assert.ok(p.reasons.includes(reason), `plan carries ${reason}`);
  }
});

test("a fully-permitted running mission plans the full advance: exits → refresh → scan → approve → dispatch", () => {
  const p = planMissionTick(
    tickInput({
      auto: autoInput({
        automationLevel: 4,
        executionMode: "live",
        liveAutoEnabled: true,
        certificateAccepted: true,
        promotionApproved: true,
        driftSeverity: "NONE",
        liveGatesEnabled: true,
      }),
    }),
  );
  assert.equal(p.action, "advance");
  assert.deepEqual(p.steps, [
    "manage_exits",
    "refresh_protection",
    "scan",
    "auto_approve",
    "auto_dispatch",
  ]);
  assert.equal(p.autoApproval.allowed, true);
  assert.equal(p.autoApproval.reachesLive, true);
});
