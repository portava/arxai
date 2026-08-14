// Selects the active BrokerProvider based on env. Never throws on missing
// secrets — instead returns a provider that reports the missing-secret state
// honestly via .status().

import type { BrokerProvider } from "./types.js";
import { selectBrokerKind } from "./secrets.js";
import { MockBrokerProvider } from "./mockProvider.js";
import { MT5BridgeProvider } from "./mt5BridgeProvider.js";

let cached: BrokerProvider | null = null;

export function getBrokerProvider(): BrokerProvider {
  if (cached) return cached;
  const kind = selectBrokerKind();
  switch (kind) {
    case "mt5":
      cached = new MT5BridgeProvider();
      break;
    case "deriv":
      // No DerivProvider yet; fall back to mock with a clear note. The user
      // selected B with MT5 as primary; Deriv is left for a future session.
      cached = new MockBrokerProvider();
      break;
    case "mock":
    default:
      cached = new MockBrokerProvider();
      break;
  }
  return cached;
}

export function resetBrokerProviderForTests(): void { cached = null; }
