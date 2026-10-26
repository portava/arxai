import type { MeOpportunityMapResp } from "@workspace/api-client-react";

/** Retain a scan only while changing selection inside the same signed-in universe.
 * Its original timestamp and all display caps still apply. Never create new data. */
export function sameUniversePlaceholder(previous: MeOpportunityMapResp | undefined,
  query: { queryKey: readonly unknown[] } | undefined, marketGroup: string, userId: number | null) {
  const key = query?.queryKey;
  const params = key?.[1] as { marketGroup?: unknown } | undefined;
  return userId !== null && key?.[0] === "/api/me/opportunity-map" && key.at(-1) === userId &&
    params?.marketGroup === marketGroup && previous?.universe === marketGroup ? previous : undefined;
}
