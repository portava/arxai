import { describe,it,expect } from "vitest";
import owner from "../../../../../docs/SMART_CHART_OWNER_REQUIREMENTS.json";
import scope from "../../../../../docs/SMART_CHART_DESCRIPTIVE_SCOPE.json";
describe("owner analytical scope accounting",()=>{
 it("retains all 24 original families and every unimplemented requirement",()=>{
  expect(scope.analysisFamilies.map(f=>f.name)).toEqual(owner.analysisFamilies.map(f=>f.name));expect(scope.analysisFamilies).toHaveLength(24);
  for(const item of scope.analysisFamilies){expect(["PARTIAL","SUPPORTED_DESCRIPTIVE_SCOPE","UNAVAILABLE"]).toContain(item.status);expect(item.limitation.length).toBeGreaterThan(10);expect(item.implementedScope.length).toBeGreaterThan(10);}
  for(const name of ["Forecasting","Statistical significance","Uncertainty","Lead–lag relationships","Composition"])expect(scope.analysisFamilies.find(f=>f.name===name)!.status).toBe("UNAVAILABLE");
  expect(scope.meaning).toContain("not overall architecture");expect(scope.candlestickCoverage).toEqual({implementedDefinitions:78,ownerNamesCovered:81,ownerNamesTotal:104,pendingOwnerNames:23});
 });
});
