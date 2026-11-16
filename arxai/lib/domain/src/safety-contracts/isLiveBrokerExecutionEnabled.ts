// Single source of truth for parsing the env var
// `ARX_LIVE_BROKER_EXECUTION_ENABLED`.
//
// SAFETY: This helper does NOT relax any safety contract — it only
// normalises the env-var read so every consumer agrees on whether the
// server master switch (Phase B gate #1) is on. The default is FALSE
// for any value other than a recognised truthy form. Live broker
// dispatch additionally requires the DB arm flag AND all 16 Phase B
// gates passing — this helper is one gate, never the only one.
//
// Why this exists: prior to this helper, some sites compared against
// the exact string `"true"` (case-sensitive) and others normalised via
// `.toLowerCase()`. When the operator set the env to `True` (capital
// T), the case-sensitive sites read FALSE while the case-insensitive
// sites read TRUE, producing the "header says armed, page says
// disabled" class of bug. Every call site MUST use this helper.

/**
 * Accepts ONLY case-insensitive, trimmed `"true"` as truthy. Anything
 * else — including the empty string, `undefined`, `"false"`, `"0"`,
 * `"1"`, `"yes"`, `"on"`, or any unrecognised value — is FALSE.
 *
 * SAFETY: deliberately narrow. The pre-helper call sites compared
 * against literal `"true"` (some case-sensitive, some not). Accepting
 * additional truthy forms here would be a unilateral broadening of the
 * Phase B master-switch gate surface — outside the contract every
 * existing site agreed on. Operators set this env to the string
 * `"true"` (any casing); nothing else is valid.
 */
export function isEnvTruthy(raw: string | undefined | null): boolean {
  if (raw == null) return false;
  return String(raw).trim().toLowerCase() === "true";
}

/**
 * Reads `process.env.ARX_LIVE_BROKER_EXECUTION_ENABLED` and returns
 * the normalised boolean. Defaults to FALSE.
 */
export function isLiveBrokerExecutionEnabledEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isEnvTruthy(env["ARX_LIVE_BROKER_EXECUTION_ENABLED"]);
}
