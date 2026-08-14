import type {
  SensorReading, UserAction, UserBehaviorReading, UserBehaviorSensorPort,
} from "./liveInputs.types";

const RAPID_FIRE_PER_MINUTE = 5;
const PANIC_BLOCKER_COUNT   = 1;
const OVERRIDE_WARN_COUNT   = 3;

export interface ReadUserBehaviorSensorInput {
  port: UserBehaviorSensorPort;
  windowMinutes?: number;
  now?: Date;
}

export async function readUserBehaviorSensor(input: ReadUserBehaviorSensorInput): Promise<SensorReading<UserBehaviorReading>> {
  const now = input.now ?? new Date();
  const windowMinutes = input.windowMinutes ?? 30;
  const warnings: string[] = [];
  const blockers: string[] = [];

  const actions: UserAction[] = await input.port.getRecentActions(windowMinutes).catch(() => []);

  const cutoff = now.getTime() - windowMinutes * 60_000;
  const inWindow = actions.filter((a) => new Date(a.timestamp).getTime() >= cutoff);

  const actionsPerMinute = windowMinutes > 0 ? inWindow.length / windowMinutes : 0;
  const recentOverrides = inWindow.filter(
    (a) => a.kind === "OVERRIDE_BLOCK" || a.kind === "OVERRIDE_RISK",
  ).length;
  const recentPanics = inWindow.filter((a) => a.kind === "PANIC_BUTTON").length;
  const rapidFire = actionsPerMinute >= RAPID_FIRE_PER_MINUTE;

  if (recentPanics >= PANIC_BLOCKER_COUNT) {
    blockers.push(`User pressed panic button ${recentPanics}× in last ${windowMinutes}m — bot must stay paused until manual resume`);
  }
  if (recentOverrides >= OVERRIDE_WARN_COUNT) {
    blockers.push(`${recentOverrides} risk/block overrides in last ${windowMinutes}m — escalation required`);
  } else if (recentOverrides > 0) {
    warnings.push(`${recentOverrides} recent override${recentOverrides > 1 ? "s" : ""}`);
  }
  if (rapidFire) {
    warnings.push(`Rapid-fire user activity: ${actionsPerMinute.toFixed(1)} actions/min ≥ ${RAPID_FIRE_PER_MINUTE}`);
  }

  const value: UserBehaviorReading = {
    windowMinutes,
    actions: inWindow,
    actionsPerMinute,
    recentOverrides, recentPanics, rapidFire,
  };

  return {
    sensor: "userBehavior", value,
    health: { isHealthy: blockers.length === 0, isStale: false, ageSeconds: null,
              reasons: blockers.length === 0 ? ["normal user activity"] : blockers },
    warnings, blockers, capturedAt: now.toISOString(),
  };
}
