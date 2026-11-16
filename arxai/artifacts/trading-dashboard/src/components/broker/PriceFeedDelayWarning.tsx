// Build G — Inline warning specifically for price feed lag. Hidden when feed is healthy.
import { useGetBrokerHealth, getGetBrokerHealthQueryKey } from "@workspace/api-client-react";

export function PriceFeedDelayWarning() {
  const { data } = useGetBrokerHealth({ query: { queryKey: getGetBrokerHealthQueryKey(), refetchInterval: 5_000 } });
  if (!data) return null;
  if (data.status !== "PRICE_FEED_DELAYED") return null;
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
      <span className="font-semibold">Price feed delayed.</span>{" "}
      {data.aiExplanation}
    </div>
  );
}
