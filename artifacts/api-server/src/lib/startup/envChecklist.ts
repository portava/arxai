// Production Launch Readiness — Environment Variable Checklist.
//
// SAFETY: This module reports presence (boolean) of each required/optional
// environment variable. It NEVER reads, returns, or logs the value itself.
// Suitable for boot-time logs and admin readiness panels.

import { isLiveBrokerExecutionEnabledEnv } from "@workspace/domain/safety-contracts/isLiveBrokerExecutionEnabled";

export type EnvScope = "core" | "ai" | "market" | "bridge" | "admin" | "safety";

export interface EnvCheckItem {
  varName: string;
  present: boolean;
  required: boolean;
  scope: EnvScope;
  note: string;
  /** Why `required` resolved true for a CONDITIONALLY required var. Null for
   *  unconditional specs and for conditional ones that did not trigger. */
  requiredBecause: string | null;
}

/** A spec is either always required, or required only in some environments.
 *  A conditional spec must say WHY it became required — "missing required var"
 *  with no reason is a checklist an operator cannot act on. */
type Requirement =
  | { kind: "always"; required: boolean }
  | { kind: "conditional"; when: (env: NodeJS.ProcessEnv) => string | null };

const always = (required: boolean): Requirement => ({ kind: "always", required });
const onlyWhen = (when: (env: NodeJS.ProcessEnv) => string | null): Requirement =>
  ({ kind: "conditional", when });

function isProductionEnv(env: NodeJS.ProcessEnv): boolean {
  return (env["APP_ENV"] ?? env["NODE_ENV"] ?? "").trim().toLowerCase() === "production";
}

/** The registration-key shield is ON. Read as a value, not presence: the
 *  repository's own gate is `ARX_BETA_INVITE_REQUIRED === "true"`
 *  (lib/db/src/repositories/betaInvites.ts, isBetaInviteGateEnabled), and this
 *  checklist must agree with the code that actually enforces it. */
export function isBetaInviteGateEnabledEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["ARX_BETA_INVITE_REQUIRED"] === "true";
}

interface EnvSpec {
  varName: string;
  requirement: Requirement;
  scope: EnvScope;
  note: string;
}

const SPECS: EnvSpec[] = [
  { varName: "NODE_ENV", requirement: always(true), scope: "core", note: "Node runtime env (development|test|production)." },
  { varName: "APP_ENV", requirement: always(false), scope: "core", note: "Optional app-level env tag (defaults to NODE_ENV)." },
  { varName: "DATABASE_URL", requirement: always(true), scope: "core", note: "Postgres connection string. Auto-provisioned on Replit." },
  { varName: "SESSION_SECRET", requirement: always(true), scope: "core", note: "HMAC secret for signed session cookies." },
  { varName: "PORT", requirement: always(true), scope: "core", note: "TCP port the API listens on. Provided by the workflow." },
  { varName: "APP_BASE_URL", requirement: always(false), scope: "core", note: "Public base URL (defaults to first REPLIT_DOMAINS entry)." },

  { varName: "TWELVEDATA_API_KEY", requirement: always(false), scope: "market", note: "OHLC / market data provider. Without it the scanner returns an honest empty list." },

  { varName: "OPENAI_API_KEY", requirement: always(false), scope: "ai", note: "Ruby assistant LLM. When missing, Ruby returns a safe canned response." },

  { varName: "MT5_BRIDGE_TOKEN", requirement: always(false), scope: "bridge", note: "LEGACY server-wide bridge token. Now REJECTED on every EA endpoint — should NOT be configured. Per-user tokens are the only accepted shape." },

  { varName: "ARX_LIVE_BROKER_EXECUTION_ENABLED", requirement: always(false), scope: "safety", note: "Master switch for Phase B live dispatch. Defaults FALSE. Setting TRUE only enables the 16-gate evaluator to consider PASSing — it does not bypass any gate." },

  { varName: "ARX_ADMIN_EMAIL", requirement: always(false), scope: "admin", note: "Seeds a dedicated ADMIN account on startup. Without it no admin is auto-seeded (admin login may be unavailable)." },
  { varName: "ARX_ADMIN_INITIAL_PASSWORD", requirement: always(false), scope: "admin", note: "One-time initial password for the seeded ADMIN. Applied only when the row has no password yet; rotate then unset." },
  { varName: "ARX_OWNER_EMAIL", requirement: always(false), scope: "admin", note: "Legacy owner-bootstrap email. Leave UNSET in single-active-role mode so no account is re-elevated to ADMIN on boot." },
  { varName: "ARX_LEGACY_OWNER_DEMOTE_EMAIL", requirement: always(false), scope: "admin", note: "Email of the legacy owner to idempotently downgrade to USER (trader) on startup. Live-testing permissions are preserved." },

  // REGISTRATION_KEY_PEPPER was listed as an unconditional OPTIONAL, and its own
  // note said "Required when ARX_BETA_INVITE_REQUIRED=true" — a requirement the
  // checklist then did not apply. With the shield ON and the pepper absent, the
  // var landed in `missingOptional`, the boot log printed it beside genuinely
  // optional keys like OPENAI_API_KEY, no "launch readiness is BLOCKED" warning
  // fired, and no launch blocker was raised — while every single signup was in
  // fact being refused with PEPPER_MISSING. The checklist now applies the rule
  // its own note states.
  {
    varName: "REGISTRATION_KEY_PEPPER",
    requirement: onlyWhen((env) =>
      isBetaInviteGateEnabledEnv(env)
        ? "ARX_BETA_INVITE_REQUIRED=true — the registration-key shield is ON, so every signup and every key issuance fails closed without the pepper"
        : isProductionEnv(env)
          ? "production environment — registration-key issuance and validation fail closed without the pepper"
          : null,
    ),
    scope: "core",
    note: "HMAC pepper for ARX-format registration keys. REQUIRED when ARX_BETA_INVITE_REQUIRED=true or in production. Without it, key generation and validation fail closed (PEPPER_MISSING) — nobody can sign up and no key can be issued.",
  },
  { varName: "ARX_BETA_INVITE_REQUIRED", requirement: always(false), scope: "core", note: "Set to 'true' to enforce the registration key shield. When on, every new account creation requires a valid ARX registration key." },
];

export function computeEnvChecklist(env: NodeJS.ProcessEnv = process.env): EnvCheckItem[] {
  return SPECS.map((s) => {
    const because = s.requirement.kind === "conditional" ? s.requirement.when(env) : null;
    const required = s.requirement.kind === "always" ? s.requirement.required : because !== null;
    return {
      varName: s.varName,
      present: typeof env[s.varName] === "string" && env[s.varName] !== "",
      required,
      scope: s.scope,
      note: s.note,
      requiredBecause: because,
    };
  });
}

export interface EnvSummary {
  total: number;
  presentCount: number;
  missingRequired: string[];
  missingOptional: string[];
  presentByScope: Record<EnvScope, number>;
  liveMasterSwitchEnabled: boolean;
  legacyBridgeTokenPresent: boolean;
  /**
   * The registration-key shield is ON but REGISTRATION_KEY_PEPPER is absent.
   *
   * This is not a shade of "missing var". It is a precise, currently-true
   * statement about behaviour: `validateInviteForRegistration` and
   * `acceptInviteTx` both refuse with PEPPER_MISSING before looking at any
   * code, and `createRegistrationKey` refuses to mint one. Every signup is
   * dead and the admin cannot issue a key to fix it. It is called out
   * separately so the boot log and the readiness panel can say that, instead
   * of leaving an operator to infer it from a variable name in a list.
   */
  registrationShieldBlocked: boolean;
  /** Human-readable reasons for each CONDITIONALLY required var that is
   *  missing, keyed by var name. Empty when nothing conditional triggered. */
  missingRequiredReasons: Record<string, string>;
}

/**
 * `env` must be the SAME environment `items` was computed from. It is needed
 * because some states depend on a variable's VALUE rather than its presence
 * (ARX_BETA_INVITE_REQUIRED="true"), and an EnvCheckItem deliberately carries
 * only presence — items must never become a channel for values.
 */
export function summarizeEnvChecklist(
  items: EnvCheckItem[],
  env: NodeJS.ProcessEnv = process.env,
): EnvSummary {
  const missingRequired = items.filter((i) => i.required && !i.present).map((i) => i.varName);
  const missingOptional = items.filter((i) => !i.required && !i.present).map((i) => i.varName);
  const presentByScope: Record<EnvScope, number> = { core: 0, ai: 0, market: 0, bridge: 0, admin: 0, safety: 0 };
  for (const i of items) if (i.present) presentByScope[i.scope] = (presentByScope[i.scope] ?? 0) + 1;
  const legacy = items.find((i) => i.varName === "MT5_BRIDGE_TOKEN");
  // Value-aware read (matches canonical reader in lib/live/phaseBConfig.ts).
  // ARX_LIVE_BROKER_EXECUTION_ENABLED is a public boolean, not a secret —
  // its value is what decides whether the Phase B gate can PASS, so the
  // checklist must reflect the value, not just presence.
  // Case-insensitive read via shared helper so `True` / `TRUE` / `1`
  // don't silently disagree with other consumers (Phase B config, the
  // operator command center, the assistant tools, etc).
  const liveMasterSwitchEnabled = isLiveBrokerExecutionEnabledEnv();

  // Derived from the items themselves, not re-read from the environment, so the
  // flag can never disagree with the row it is describing.
  const pepperItem = items.find((i) => i.varName === "REGISTRATION_KEY_PEPPER");
  const shieldItem = items.find((i) => i.varName === "ARX_BETA_INVITE_REQUIRED");
  const registrationShieldBlocked =
    !!shieldItem?.present && isBetaInviteGateEnabledEnv(env) && !pepperItem?.present;

  const missingRequiredReasons: Record<string, string> = {};
  for (const i of items) {
    if (i.required && !i.present && i.requiredBecause !== null) {
      missingRequiredReasons[i.varName] = i.requiredBecause;
    }
  }

  return {
    total: items.length,
    presentCount: items.filter((i) => i.present).length,
    missingRequired,
    missingOptional,
    presentByScope,
    liveMasterSwitchEnabled,
    legacyBridgeTokenPresent: !!legacy?.present,
    registrationShieldBlocked,
    missingRequiredReasons,
  };
}
