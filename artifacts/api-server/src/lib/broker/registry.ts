// Selects the active BrokerProvider based on env. Never throws on missing
// secrets — instead returns a provider that reports the missing-secret state
// honestly via .status().

import type { BrokerProvider, BrokerStatus } from "./types.js";
import { selectBrokerKind, describeRequiredSecrets } from "./secrets.js";
import { MockBrokerProvider } from "./mockProvider.js";
import { MT5BridgeProvider } from "./mt5BridgeProvider.js";

// No Deriv adapter exists in this build. When BROKER_PROVIDER=deriv is set the
// selection must NOT silently fall back to mock data — status() reports
// NOT_IMPLEMENTED and every data read returns empty, never synthetic values.
class DerivNotImplementedProvider implements BrokerProvider {
  readonly kind = "deriv" as const;

  async status(): Promise<BrokerStatus> {
    return {
      kind: this.kind,
      connected: false,
      health: {
        connected: false,
        lastHeartbeatAt: null,
        staleSeconds: null,
        reason: "DERIV_PROVIDER_NOT_IMPLEMENTED — BROKER_PROVIDER=deriv is set but no Deriv adapter exists in this build.",
      },
      environment: "NOT_CONFIGURED",
      liveTradingAllowed: false,
      canPlaceLiveTrade: false,
      missingSecrets: describeRequiredSecrets("deriv"),
      notes: [
        "providerState=NOT_IMPLEMENTED. No Deriv adapter is built; no broker data is fabricated.",
        "Set BROKER_PROVIDER=mt5 (with MT5_BRIDGE_TOKEN) to use the real MT5 bridge, or unset BROKER_PROVIDER for the clearly-labelled mock.",
      ],
    };
  }

  async account() { return null; }
  async symbols() { return []; }
  async positions() { return []; }
  async orders() { return []; }
}

let cached: BrokerProvider | null = null;

export function getBrokerProvider(): BrokerProvider {
  if (cached) return cached;
  const kind = selectBrokerKind();
  switch (kind) {
    case "mt5":
      cached = new MT5BridgeProvider();
      break;
    case "deriv":
      cached = new DerivNotImplementedProvider();
      break;
    case "mock":
    default:
      cached = new MockBrokerProvider();
      break;
  }
  return cached;
}

export function resetBrokerProviderForTests(): void { cached = null; }
