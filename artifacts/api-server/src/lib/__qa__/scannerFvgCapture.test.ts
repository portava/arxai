import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { resolveArxMarket } from "@workspace/domain/market";
import { bindScannerSource, scannerRowVenueIdentity } from "../scannerInputIntegrity.js";
import { analyzeFvgTrendPullback } from "../fvg/fvgTrendPullback.js";

let calls = 0, budgetCalls = 0;
const getChartCandles = async (symbol: string, timeframe: string, count: number) => {
  calls++;
  const interval = timeframe === "H4" ? 14400000 : timeframe === "H1" ? 3600000 : 300000;
  const end = Date.parse("2026-10-30T16:00:00Z");
  return {
    symbol, timeframe, source: "provider", aiUsable: true,
    feedStatus: { source: "provider", aiUsable: true, stale: false },
    marketEvidence: {symbol, timeframe, source: "provider", sourceIdentity: `provider:${symbol}:${timeframe}`, venueIdentity: "A", lastClosedCandleAt: new Date(end).toISOString()},
    candles: Array.from({length:count},(_,i)=>({openTime:new Date(end-(count-i)*interval).toISOString(),closeTime:new Date(end-(count-i-1)*interval).toISOString(),open:100+i,high:102+i,low:99+i,close:101+i,isComplete:true,isForming:false,timeBasisEvidence:{kind:"original_utc",basis:"UTC",authority:"normalized-test-boundary",reason:null}})),
  };
};
mock.module("../data/chart/chartDataService.js", { namedExports: {getChartCandles} });
const { captureFvgChartInputs } = await import("../data/chart/fvgChartContext.js");

// Execute the current decorator body verbatim, replacing module imports and
// scheduler boundaries to avoid initializing the full scanner's DB/workers.
// This validates grouping and projection, not real scheduler concurrency.
const source = readFileSync(new URL("../marketScanner.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("marketScanner.ts",source,ts.ScriptTarget.Latest,true);
const fn = ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==="decorateOpportunitiesWithFvgRead");
assert.ok(fn);
const body = fn.getText(ast).replace("export async function", "async function").replace(/await import\("([^"]+)"\)/g,(_,path)=>`modules[${JSON.stringify(path)}]`);
const js = ts.transpile(body, {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS});
const decorate = new Function("modules","resolveArxMarket","scannerRowVenueIdentity","mapWithConcurrency","ENRICHMENT_CONCURRENCY","runWithScannerBudget",`${js}; return decorateOpportunitiesWithFvgRead;`)(
  {"./data/chart/chartDataService.js":{getChartCandles},"./data/chart/fvgChartContext.js":{captureFvgChartInputs},"./fvg/fvgTrendPullback.js":{analyzeFvgTrendPullback}},
  resolveArxMarket, scannerRowVenueIdentity,
  async (items: string[], cap: number, work: (key:string)=>Promise<void>)=>{assert.equal(cap,4); for(const item of items) await work(item);},4,
  async (work:()=>Promise<unknown>)=>{budgetCalls++;return work();},
);

test("Scanner isolates same-symbol FVG by source and keeps unknown attribution withheld",async()=>{
  calls=budgetCalls=0;
  const row=(venue?:string,provider="provider")=>bindScannerSource({symbol:"EURUSD",feedProvider:provider,opportunity:{score:22},tradeable:false},"interval-bound",venue);
  const a=row("A"), a2={...a}, b=row("B"), unknown=row(), provider=row("A","other");
  const result=await decorate([a,a2,b,unknown,provider]);
  assert.equal(result.length,5);
  assert.notEqual(result[0].fvgRead.stage,"NO_DATA");
  assert.equal(result[0].fvgRead,result[1].fvgRead,"identical source scope shares one observation");
  for(const other of result.slice(2)) {
    assert.equal(other.fvgRead.stage,"NO_DATA"); assert.equal(other.fvgRead.canSignal,false);
    assert.equal(other.fvgRead.direction,"WAIT"); assert.deepEqual(other.fvgRead.overlays,[]);
    assert.equal(other.fvgRead.activeFvg,null);
  }
  assert.equal(calls,12); assert.equal(budgetCalls,12);
  result.forEach((r:any)=>{assert.equal(r.tradeable,false);assert.deepEqual(r.opportunity,{score:22});});
  assert.equal((a as any).fvgRead,undefined,"decorator must not mutate source rows");
});
test("empty Scanner input does not request FVG data",async()=>{
  calls=budgetCalls=0;assert.deepEqual(await decorate([]),[]);assert.equal(calls,0);
});
