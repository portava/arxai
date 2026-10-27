import { describe, expect, it } from "vitest";
import type { MeOpportunityMapResp } from "@workspace/api-client-react";
import { sameUniversePlaceholder } from "./scannerMapQuery";
const data = { universe: "all", generatedAt: "2026-10-26T12:00:00Z" } as MeOpportunityMapResp;
const query = { queryKey: ["/api/me/opportunity-map", { marketGroup: "all", selectedSymbol: "EURUSD" }, 1] };
describe("same-universe scanner continuity", () => {
  it("preserves the exact original object and timestamp while selection changes", () => {
    expect(sameUniversePlaceholder(data, query, "all", 1)).toBe(data);
  });
  it.each([2, null])("withholds another or absent account %s", (actor) => {
    expect(sameUniversePlaceholder(data, query, "all", actor)).toBeUndefined();
  });
  it("withholds another universe or mismatched response", () => {
    expect(sameUniversePlaceholder(data, query, "forex", 1)).toBeUndefined();
    expect(sameUniversePlaceholder({ ...data, universe: "forex" }, query, "all", 1)).toBeUndefined();
  });
  it("withholds unknown or legacy unscoped keys", () => {
    expect(sameUniversePlaceholder(data, undefined, "all", 1)).toBeUndefined();
    expect(sameUniversePlaceholder(data, { queryKey: query.queryKey.slice(0, 2) }, "all", 1)).toBeUndefined();
  });
});
