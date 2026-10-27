import { useLayoutEffect, useRef } from "react";
import type { ChartCandlesResult } from "@/lib/chartCandlesQuery";

/** Legacy overlay DTOs have no source attestation. Once a previously viewed
 * symbol/timeframe changes source identity, they may not restore old geometry. */
export function useDerivedOverlayContext(scope: string, identity: string | null): boolean {
  const previous = useRef(new Map<string, string>());
  const requireEvidence = useRef(new Set<string>());
  const prior = previous.current.get(scope);
  const changed = identity != null && prior != null && prior !== identity;
  const restricted = changed || requireEvidence.current.has(scope);
  useLayoutEffect(() => {
    if (identity == null) return;
    if (changed) requireEvidence.current.add(scope);
    previous.current.set(scope, identity);
  }, [scope, identity, changed]);
  return restricted;
}

export function hasMatchingOverlayEvidence(
  expected: ChartCandlesResult["marketEvidence"],
  response: unknown,
): boolean {
  if (!expected || !response || typeof response !== "object") return false;
  const evidence = (response as { marketEvidence?: unknown }).marketEvidence;
  if (!evidence || typeof evidence !== "object") return false;
  const actual = evidence as Record<string, unknown>;
  return expected.sourceIdentity.length > 0 && actual.sourceIdentity === expected.sourceIdentity
    && actual.symbol === expected.symbol && actual.timeframe === expected.timeframe && actual.source === expected.source;
}
