// Detect broker-related secrets WITHOUT crashing if any are missing.
// Never logs secret values. Returns presence-only metadata.

import type { BrokerSecretRequirement, BrokerKind } from "./types.js";

export function selectBrokerKind(): BrokerKind {
  const raw = (process.env.BROKER_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "mt5") return "mt5";
  if (raw === "deriv") return "deriv";
  return "mock";
}

export function describeRequiredSecrets(kind: BrokerKind): BrokerSecretRequirement[] {
  switch (kind) {
    case "mt5":
      return [
        { key: "MT5_BRIDGE_TOKEN", required: true, set: !!process.env.MT5_BRIDGE_TOKEN, description: "Shared secret the MT5 EA must send in X-MT5-Bridge-Token. Without it all bridge endpoints fail-closed (503)." },
        { key: "MT5_BRIDGE_URL", required: false, set: !!process.env.MT5_BRIDGE_URL, description: "Optional. Outbound bridge URL if this server polls/pushes to a bridge. The current build only receives EA heartbeats." },
        { key: "MT5_ACCOUNT_ID", required: false, set: !!process.env.MT5_ACCOUNT_ID, description: "Optional. Used for account-id binding/audit display." },
        { key: "MT5_ENVIRONMENT", required: false, set: !!process.env.MT5_ENVIRONMENT, description: "Optional. \"demo\" or \"live\". Defaults to whatever the EA reports." },
      ];
    case "deriv":
      return [
        { key: "DERIV_API_TOKEN", required: true, set: !!process.env.DERIV_API_TOKEN, description: "Deriv API token (required for any Deriv API call)." },
        { key: "DERIV_ACCOUNT_ID", required: false, set: !!process.env.DERIV_ACCOUNT_ID, description: "Optional. Account selector." },
        { key: "DERIV_ENVIRONMENT", required: false, set: !!process.env.DERIV_ENVIRONMENT, description: "Optional. \"demo\" or \"real\"." },
      ];
    case "mock":
    default:
      return [];
  }
}

export function missingRequiredSecrets(reqs: BrokerSecretRequirement[]): BrokerSecretRequirement[] {
  return reqs.filter(r => r.required && !r.set);
}
