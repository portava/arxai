// Task #705 — Backend Fix Agent configuration (fail-safe defaults).
//
// All flags are read from process.env with conservative defaults:
//   - enabled  : OFF unless CLAUDE_FIX_AGENT_ENABLED is exactly "true".
//   - dryRun   : ON unless CLAUDE_FIX_AGENT_DRY_RUN is exactly "false".
//   - provider : "replit_managed" unless CLAUDE_PROVIDER selects a supported key.
//   - model    : "claude-sonnet-4-6" unless CLAUDE_MODEL selects an allowed model.
//
// The parsers are intentionally NARROW (cf. ARX_LIVE_BROKER_EXECUTION_ENABLED):
// only an exact, trimmed, lowercased literal flips a flag — never 1/yes/on.

import { type AIProviderKey, isSupportedProvider } from "./providers/factory";

// Allowed models for this build. claude-3-5-sonnet-latest is NOT available on
// the managed proxy and is intentionally excluded.
export const ALLOWED_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-8",
] as const;
export type AllowedModel = (typeof ALLOWED_MODELS)[number];

export const DEFAULT_MODEL: AllowedModel = "claude-sonnet-4-6";
export const DEFAULT_PROVIDER: AIProviderKey = "replit_managed";

export interface FixAgentConfig {
  enabled: boolean;
  dryRun: boolean;
  provider: AIProviderKey;
  model: AllowedModel;
}

function isExactlyTrue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function isExactlyFalse(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "false";
}

export function isAllowedModel(value: string): value is AllowedModel {
  return (ALLOWED_MODELS as readonly string[]).includes(value);
}

/** Resolve config fresh from the environment on every call (testable). */
export function getFixAgentConfig(): FixAgentConfig {
  const enabled = isExactlyTrue(process.env.CLAUDE_FIX_AGENT_ENABLED);

  // dryRun is ON by default; only an explicit "false" turns it off. Even then,
  // the service never applies a patch in this build (no APPLY path exists).
  const dryRun = !isExactlyFalse(process.env.CLAUDE_FIX_AGENT_DRY_RUN);

  const rawProvider = (process.env.CLAUDE_PROVIDER ?? "").trim();
  const provider: AIProviderKey = isSupportedProvider(rawProvider)
    ? rawProvider
    : DEFAULT_PROVIDER;

  const rawModel = (process.env.CLAUDE_MODEL ?? "").trim();
  const model: AllowedModel = isAllowedModel(rawModel) ? rawModel : DEFAULT_MODEL;

  return { enabled, dryRun, provider, model };
}
