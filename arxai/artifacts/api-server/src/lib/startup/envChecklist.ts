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
}

interface EnvSpec {
  varName: string;
  required: boolean;
  scope: EnvScope;
  note: string;
}

const SPECS: EnvSpec[] = [
  { varName: "NODE_ENV", required: true, scope: "core", note: "Node runtime env (development|test|production)." },
  { varName: "APP_ENV", required: false, scope: "core", note: "Optional app-level env tag (defaults to NODE_ENV)." },
  { varName: "DATABASE_URL", required: true, scope: "core", note: "Postgres connection string. Auto-provisioned on Replit." },
  { varName: "SESSION_SECRET", required: true, scope: "core", note: "HMAC secret for signed session cookies." },
  { varName: "PORT", required: true, scope: "core", note: "TCP port the API listens on. Provided by the workflow." },
  { varName: "APP_BASE_URL", required: false, scope: "core", note: "Public base URL (defaults to first REPLIT_DOMAINS entry)." },

  { varName: "TWELVEDATA_API_KEY", required: false, scope: "market", note: "OHLC / market data provider. Without it the scanner returns an honest empty list." },

  { varName: "OPENAI_API_KEY", required: false, scope: "ai", note: "Ruby assistant LLM. When missing, Ruby returns a safe canned response." },

  { varName: "MT5_BRIDGE_TOKEN", required: false, scope: "bridge", note: "LEGACY server-wide bridge token. Now REJECTED on every EA endpoint — should NOT be configured. Per-user tokens are the only accepted shape." },

  { varName: "ARX_LIVE_BROKER_EXECUTION_ENABLED", required: false, scope: "safety", note: "Master switch for Phase B live dispatch. Defaults FALSE. Setting TRUE only enables the 16-gate evaluator to consider PASSing — it does not bypass any gate." },

  { varName: "ARX_ADMIN_EMAIL", required: false, scope: "admin", note: "Seeds a dedicated ADMIN account on startup. Without it no admin is auto-seeded (admin login may be unavailable)." },
  { varName: "ARX_ADMIN_INITIAL_PASSWORD", required: false, scope: "admin", note: "One-time initial password for the seeded ADMIN. Applied only when the row has no password yet; rotate then unset." },
  { varName: "ARX_OWNER_EMAIL", required: false, scope: "admin", note: "Legacy owner-bootstrap email. Leave UNSET in single-active-role mode so no account is re-elevated to ADMIN on boot." },
  { varName: "ARX_LEGACY_OWNER_DEMOTE_EMAIL", required: false, scope: "admin", note: "Email of the legacy owner to idempotently downgrade to USER (trader) on startup. Live-testing permissions are preserved." },

  { varName: "REGISTRATION_KEY_PEPPER", required: false, scope: "core", note: "HMAC pepper for ARX-format registration keys. Required when ARX_BETA_INVITE_REQUIRED=true. Without it, key generation and validation fail closed." },
  { varName: "ARX_BETA_INVITE_REQUIRED", required: false, scope: "core", note: "Set to 'true' to enforce the registration key shield. When on, every new account creation requires a valid ARX registration key." },
];

export function computeEnvChecklist(env: NodeJS.ProcessEnv = process.env): EnvCheckItem[] {
  return SPECS.map((s) => ({
    varName: s.varName,
    present: typeof env[s.varName] === "string" && env[s.varName] !== "",
    required: s.required,
    scope: s.scope,
    note: s.note,
  }));
}

export interface EnvSummary {
  total: number;
  presentCount: number;
  missingRequired: string[];
  missingOptional: string[];
  presentByScope: Record<EnvScope, number>;
  liveMasterSwitchEnabled: boolean;
  legacyBridgeTokenPresent: boolean;
}

export function summarizeEnvChecklist(items: EnvCheckItem[]): EnvSummary {
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
  return {
    total: items.length,
    presentCount: items.filter((i) => i.present).length,
    missingRequired,
    missingOptional,
    presentByScope,
    liveMasterSwitchEnabled,
    legacyBridgeTokenPresent: !!legacy?.present,
  };
}
