import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { refreshSelectedMarket, selectedMarketQueryOptions } from "@/lib/selectedMarketQuery";

/** One authenticated read shared by the explanation panel and header truth cap. */
export function useSelectedMarketSnapshot(symbol: string, timeframe: string) {
  const { user } = useCurrentUser();
  const client = useQueryClient();
  const options = selectedMarketQueryOptions(user?.id ?? null, symbol, timeframe);
  const query = useQuery(options);
  return {
    ...query,
    queryKey: options.queryKey,
    enabled: options.enabled,
    refresh: () => refreshSelectedMarket(client, user?.id ?? null, symbol, timeframe),
  };
}
