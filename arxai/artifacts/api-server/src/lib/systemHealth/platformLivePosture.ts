// Platform live-execution posture, in plain English, for reports that are not
// about one account (System Health, the readiness gate). Words come from the
// one switch authority, readPlatformSwitches().liveBrokerExecution (server
// setting AND operator arm). Per-account posture is ./livePosture.ts.
//
// Describes only: nothing here arms, enables or loosens anything, no gate
// reads it, and an unreadable switch is reported as UNKNOWN.

import { readPlatformSwitches, type PlatformSwitches } from "../safety/platformSwitches.js";

export const PLATFORM_POSTURE_SOURCE =
  "Platform live-execution switch (server setting AND operator arm, global_trading_settings)";

export interface PlatformLivePosture {
  state: "ON" | "OFF" | "UNKNOWN";
  serverSettingOn: boolean | null;
  operatorArmed: boolean | null;
  plainEnglish: string;
  source: string;
  checkedAt: string;
}

export function hhmm(at: Date): string {
  return at.toISOString().slice(11, 16) + " UTC";
}

/** Pure: the platform live-execution posture from one switch read. */
export function platformPostureFrom(
  switches: Pick<PlatformSwitches, "readable" | "liveBrokerExecution">,
  at: Date = new Date(),
): PlatformLivePosture {
  const checkedAt = at.toISOString();
  if (!switches.readable) {
    return {
      state: "UNKNOWN",
      serverSettingOn: null,
      operatorArmed: null,
      plainEnglish:
        `The platform's live-execution switch could not be read (tried ${hhmm(at)}), so it is unknown whether live orders can be sent. ` +
        "Order checks treat an unreadable switch as off.",
      source: PLATFORM_POSTURE_SOURCE,
      checkedAt,
    };
  }
  const lbe = switches.liveBrokerExecution;
  const onOff = (b: boolean) => (b ? "on" : "off");
  const detail = `server setting ${onOff(lbe.envEnabled)}, operator arm ${onOff(lbe.operatorArmed)}`;
  return lbe.enabled
    ? {
        state: "ON",
        serverSettingOn: lbe.envEnabled,
        operatorArmed: lbe.operatorArmed,
        plainEnglish:
          `Live broker execution is switched on for the platform (${detail}; checked ${hhmm(at)}). ` +
          "An account sends live orders only when it is armed and every server check passes.",
        source: PLATFORM_POSTURE_SOURCE,
        checkedAt,
      }
    : {
        state: "OFF",
        serverSettingOn: lbe.envEnabled,
        operatorArmed: lbe.operatorArmed,
        plainEnglish: `Live broker execution is switched off for the platform (${detail}; checked ${hhmm(at)}).`,
        source: PLATFORM_POSTURE_SOURCE,
        checkedAt,
      };
}

/** The platform posture from one switch read. Never throws (the reader fails closed to "unreadable"). */
export async function readPlatformLivePosture(): Promise<PlatformLivePosture> {
  try {
    return platformPostureFrom(await readPlatformSwitches());
  } catch {
    return platformPostureFrom({ readable: false, liveBrokerExecution: { envEnabled: false, operatorArmed: false, enabled: false, armedAt: null, armedBy: null, armedBridgeId: null } });
  }
}
