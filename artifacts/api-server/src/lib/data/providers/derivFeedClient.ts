// Data routing only. Account/certification callers retain their existing
// getDerivWsClient/newApi transports and cannot borrow this public session.
import { getDerivWsClient } from "./derivWsClient.js";
import { DERIV_SYNTHETIC_SYMBOLS } from "./derivProvider.js";
import { DerivPublicDataClient, derivPublicDataEnabled } from "./derivPublicDataClient.js";
let publicClient: DerivPublicDataClient | null = null;
export function getDerivFeedClient() {
  if (!derivPublicDataEnabled()) return getDerivWsClient();
  return publicClient ??= new DerivPublicDataClient(DERIV_SYNTHETIC_SYMBOLS);
}
export const derivMarketDataConfigured = () => derivPublicDataEnabled() || Boolean(process.env.DERIV_APP_ID?.trim());
export const derivMarketDataSource = () => derivPublicDataEnabled() ? "deriv_public" as const : "deriv" as const;
