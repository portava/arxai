// Task #32 — Remote EA configuration contract (pure, server + dashboard shared).
//
// ARX may push SAFE operational tunables to the EA remotely. This contract is
// the single source of truth for WHAT is allowed and — far more importantly —
// what is HARD-EXCLUDED and can never be delivered to or applied by the EA.
//
// SAFETY (inviolable — see SAFETY_NOTES.md):
// Remote config can NEVER override any of these protected surfaces:
//   - MT5 terminal "Allow Algo Trading" / AlgoTrading permission
//   - the broker connection (login / server / terminal-connected state)
//   - the EA's LOCAL ReadOnlyMode input
//   - the EA's LOCAL EnableLiveExecution input
//   - the ARX kill switch
//   - the Phase B 16-gate evaluator
//   - the liveTrading chokepoint (placeLiveOrderGuarded)
// These are decided locally / by the operator at the terminal and by the
// server-side gates. A remote config payload that even MENTIONS one of them is
// rejected (strict) or stripped (lenient) — it is never written, never served,
// never applied. Importing this file does NOT unlock anything; it only ever
// removes/refuses fields.

// Allow-listed tunables the EA may accept from remote config. This is a CLOSED
// set; any key not in it is dropped. Keep in sync with the eaRemoteConfigTable
// columns (and the EA's SyncRemoteConfigNow consumer).
export const ALLOWED_REMOTE_CONFIG_KEYS = [
  "heartbeatPeriodSeconds",
  "pollIntervalSeconds",
  "snapshotPeriodSeconds",
  "dealHistorySyncSeconds",
  "symbolSpecPeriodSeconds",
  "verboseDiagnostics",
  "maxSpreadPoints",
  "maxDeviationPoints",
  "quoteFreshnessSeconds",
  "defaultCommandTtlSeconds",
  "retryMaxAttempts",
  "retryBackoffMs",
  "maxLiveLotCeiling",
  "closeCommandSupportEnabled",
  "maintenanceMode",
  "allowedCommandTypes",
] as const;

export type AllowedRemoteConfigKey = (typeof ALLOWED_REMOTE_CONFIG_KEYS)[number];

// HARD-EXCLUDED fields. Any of these keys (in any casing) appearing in a remote
// config payload is a protected-field violation. The list is intentionally
// broad and includes common aliases an operator or buggy client might send, so
// the guard fails closed rather than silently passing an unrecognised alias of
// a protected surface.
export const PROTECTED_REMOTE_CONFIG_FIELDS = [
  // MT5 AlgoTrading permission.
  "algotrading", "algotradingallowed", "allowalgotrading", "enablealgotrading",
  "expertsenabled", "tradingallowed", "tradeallowed",
  // Broker connection.
  "brokerconnection", "brokerserver", "server", "login", "accountlogin",
  "accountnumber", "terminalconnected", "brokerlogin", "password",
  "investorpassword", "connectionstring",
  // EA LOCAL safety inputs — only the operator sets these at the terminal.
  "readonlymode", "readonly", "enableliveexecution", "enablelive",
  "livetradingenabled", "maxlivelot", // local MaxLiveLot input is protected;
                                       // remote can only LOWER via maxLiveLotCeiling
  // ARX kill switch.
  "killswitch", "killswitchengaged", "emergencystop", "globallive",
  "globalkill", "tradinghalted",
  // Phase B 16-gate evaluator / dispatch authority.
  "gate", "gates", "dispatchgate", "phaseb", "phasebgate",
  "livebrokerexecutionenabled", "arxlivebrokerexecutionenabled",
  "all-16-gates", "sixteengate", "overridegate", "bypassgate", "bypassgates",
  // liveTrading chokepoint.
  "livelocked", "alloworderexecution", "commandexecutionallowed",
  "placeliveorder", "placeliveorderguarded", "chokepoint", "brokerplacement",
  "autoclosemode", "autoclose",
] as const;

export type RemoteConfigViolation = {
  key: string;
  reason: "PROTECTED_FIELD";
};

export interface SanitiseRemoteConfigResult<T = Record<string, unknown>> {
  ok: boolean;
  // The cleaned payload containing ONLY allow-listed keys.
  clean: Partial<T>;
  // Allow-listed keys that were not present (informational).
  droppedUnknownKeys: string[];
  // Protected-field hits. Non-empty ⇒ a violation occurred.
  violations: RemoteConfigViolation[];
}

function normaliseKey(k: string): string {
  // Lowercase + strip separators so "Read_Only-Mode", "readOnlyMode" and
  // "readonly mode" all collapse onto the same protected token.
  return k.toLowerCase().replace(/[\s_\-.]/g, "");
}

const PROTECTED_SET = new Set(
  PROTECTED_REMOTE_CONFIG_FIELDS.map((f) => normaliseKey(f)),
);
const ALLOWED_SET = new Set<string>(ALLOWED_REMOTE_CONFIG_KEYS);

/**
 * Returns true if the given key is a protected surface that remote config can
 * never carry. Casing/separator-insensitive.
 */
export function isProtectedRemoteConfigField(key: string): boolean {
  return PROTECTED_SET.has(normaliseKey(key));
}

/**
 * Pure sanitiser. Splits an arbitrary remote-config payload into:
 *   - `clean`: only the allow-listed keys (safe to persist + deliver),
 *   - `violations`: any protected-field key present (fail-closed signal),
 *   - `droppedUnknownKeys`: keys that are neither allow-listed nor protected.
 *
 * `ok` is false when ANY protected field appears. Callers MUST refuse the write
 * when `ok === false`; they must never persist or serve `clean` in that case if
 * `strict` is desired — see `assertNoProtectedFields`.
 */
export function sanitiseRemoteConfig<T = Record<string, unknown>>(
  raw: unknown,
): SanitiseRemoteConfigResult<T> {
  const clean: Record<string, unknown> = {};
  const droppedUnknownKeys: string[] = [];
  const violations: RemoteConfigViolation[] = [];

  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (isProtectedRemoteConfigField(key)) {
        violations.push({ key, reason: "PROTECTED_FIELD" });
        continue; // never copy a protected field into clean.
      }
      if (ALLOWED_SET.has(key)) {
        clean[key] = value;
      } else {
        droppedUnknownKeys.push(key);
      }
    }
  }

  return {
    ok: violations.length === 0,
    clean: clean as Partial<T>,
    droppedUnknownKeys,
    violations,
  };
}

/**
 * Strict guard for the write path: throws if any protected field is present.
 * Use inside the admin PUT handler BEFORE persisting so a protected-field
 * payload can never be written.
 */
export function assertNoProtectedFields(raw: unknown): void {
  const { violations } = sanitiseRemoteConfig(raw);
  if (violations.length > 0) {
    const keys = violations.map((v) => v.key).join(", ");
    throw new Error(`REMOTE_CONFIG_PROTECTED_FIELD_REJECTED: ${keys}`);
  }
}
