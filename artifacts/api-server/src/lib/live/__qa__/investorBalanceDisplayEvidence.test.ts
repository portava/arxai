// Execute the actual pure composer/wire projection without importing its DB/provider dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { buildLiveAccountSnapshot, type LivePositionRow } from '../liveAccountSnapshot.js';
const source=readFileSync(new URL('../investorLiveBalance.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('composer.ts',source,ts.ScriptTarget.Latest,true);
const names=['computeAvailableBalance','mapFreshnessStatus','modeToSource','composeInvestorBalance','toInvestorLiveBalanceWire'];
const declarations=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name&&names.includes(n.name.text));
assert.equal(declarations.length,names.length,'All production pure functions must be present');
const selected=declarations.map(n=>n.getText(ast).replace(/^export /,'')).join('\n');
const js=ts.transpileModule('const round2=(n:number)=>Math.round(n*100)/100;\n'+selected,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
const {composeInvestorBalance:compose,toInvestorLiveBalanceWire:wire}=vm.runInNewContext(js+';({composeInvestorBalance,toInvestorLiveBalanceWire})');
const now=1700000000000;
const row=(id:number,pl:number|null):LivePositionRow=>({id,brokerTicket:String(id),symbol:'EURUSD',side:'buy',volume:1,entryPrice:1,currentPrice:1,floatingPl:pl,stopLoss:null,takeProfit:null,closedAt:null,reconcileState:null,lastSyncedAtMs:now-1});
const input=(rows:LivePositionRow[])=>({userId:7,accountMode:'LIVE_SHARED',allocatedBalance:1000,realizedPnL:20,reservedRisk:100,now,liveSnapshot:buildLiveAccountSnapshot({userId:7,accountMode:'LIVE_SHARED',rows,now})});
test('partial position P/L stays unknown on the canonical wire while allocation arithmetic/gates stay unchanged',()=>{
 const output=compose(input([row(1,-10),row(2,null)])); const result=wire(output);
 assert.equal(result.valueScope,'arx_allocation'); assert.equal(result.positionPnlComplete,false);
 assert.equal(result.floatingPnL,null); assert.equal(output.availableBalance,890); assert.equal(output.marginUsed,100);
 assert.equal(result.liveEquity,1010); assert.equal(result.freeMargin,910); // Preserve the previous unverified read-model subtotal; UI must withhold it.
 assert.equal(result.monetaryScopeVerified,false);
});
test('complete supplied rows retain real zero/negative P/L and scope metadata',()=>{
 const result=wire(compose(input([row(1,0),row(2,-10)])));
 assert.equal(result.positionPnlComplete,true);assert.equal(result.floatingPnL,-10);assert.equal(result.valueScope,'arx_allocation');
});
test('empty or legacy snapshots do not prove completeness of a broker account',()=>{
 const arg=input([]); assert.equal(wire(compose(arg)).positionPnlComplete,false);
 const legacy={...arg,liveSnapshot:{...arg.liveSnapshot,reconciliation:undefined}};
 assert.equal(wire(compose(legacy)).positionPnlComplete,false);
});

test('pending-realized evidence propagates through composer and canonical wire',()=>{
 const result=wire(compose({...input([row(1,-10)]),realizedPnLPendingCount:1}));
 assert.equal(result.realizedPnLPendingCount,1);assert.equal(result.positionPnlComplete,true);
});
test('quote-based estimate metadata survives the canonical wire without becoming broker profit',()=>{
 const arg=input([row(1,-10)]);arg.liveSnapshot.positions[0]!.plIsEstimate=true;arg.liveSnapshot.positions[0]!.plSource='computed';
 const result=wire(compose(arg));assert.equal(result.positionPnlEstimated,true);assert.equal(result.valueScope,'arx_allocation');
});
test('all existing stream/reconcile composers pass pending ledger evidence from their parts',()=>{
 const text=readFileSync(new URL('../../../routes/meLive.ts',import.meta.url),'utf8');
 const tree=ts.createSourceFile('route.ts',text,ts.ScriptTarget.Latest,true);let count=0;
 function visit(node:ts.Node){if(ts.isCallExpression(node)&&node.expression.getText(tree)==='composeInvestorBalance'){
  const arg=node.arguments[0]!;assert.ok(ts.isObjectLiteralExpression(arg));
  const fields=new Map(arg.properties.filter(ts.isPropertyAssignment).map(p=>[p.name.getText(tree),p.initializer.getText(tree)]));
  const parts=fields.get('realizedPnL')?.split('.')[0];assert.ok(parts==='partsOn'||parts==='partsOff');
  assert.equal(fields.get('realizedPnLPendingCount'),parts+'.realizedPnLPendingCount');count++;
 }ts.forEachChild(node,visit);}visit(tree);assert.equal(count,4);
});

test('numeric row completeness does not verify account/currency scope',()=>{
 const result=wire(compose(input([row(1,10)])));assert.equal(result.positionPnlComplete,true);assert.equal(result.monetaryScopeVerified,false);
});
for(const [path,expression] of [['../../../routes/meAccountShell.ts','toInvestorLiveBalanceWire(inv)'],['../../../routes/adminAllocations.ts','toInvestorLiveBalanceWire(inv)'],['../../assistant/rubyContext.ts','toInvestorLiveBalanceWire(inv)']] as const){
 test(`${path} reuses the canonical metadata-preserving projection`,()=>{
  const text=readFileSync(new URL(path,import.meta.url),'utf8');assert.ok(text.includes(expression));assert.ok(!text.includes('liveEquity: inv.liveEquity'));
 });
}

for(const timestamp of [NaN,Infinity,-Infinity,now+1,0]) test(`invalid timestamp ${timestamp} is safe through the full snapshot/composer chain`,()=>{
 const arg=input([{...row(1,10),lastSyncedAtMs:timestamp}]);
 assert.equal(arg.liveSnapshot.lastBrokerSnapshotAtMs,undefined);
 const result=wire(compose(arg));assert.equal(result.freshness.status,'unavailable');assert.equal(result.freshness.lastUpdatedAt,null);
});

test('actual Ruby briefing names a supplied-row diagnostic without inventing currency or account profit',()=>{
 const text=readFileSync(new URL('../../assistant/rubyContext.ts',import.meta.url),'utf8');
 const tree=ts.createSourceFile('ruby.ts',text,ts.ScriptTarget.Latest,true);const wanted=['fmtMoney','minutesUntil','newsRiskStatement','composeRubyBriefing','buildSuggestions'];
 const declarations=tree.statements.filter(n=>ts.isFunctionDeclaration(n)&&n.name&&wanted.includes(n.name.text));assert.equal(declarations.length,wanted.length);
 const code=declarations.map(n=>n.getText(tree).replace(/^export /,'')).join('\n');
 const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const composeBriefing=vm.runInNewContext(js+';composeRubyBriefing');
 const result=composeBriefing({generatedAt:new Date(now).toISOString(),page:{key:'/',label:'Cockpit'},timeOfDay:'morning',bridge:{connected:false,availability:'UNAVAILABLE'},session:null,symbol:null,isPrivileged:false,account:{openPositions:1,openPL:12,snapshotFreshness:'fresh',mt5:null,allocation:null},calendar:{connected:false,next:null},news:{connected:false,items:[]},weather:{available:false},location:{available:false},performance:{hasTrades:false},warnings:[]});
 const line=result.lines.find((value:string)=>value.includes('P/L subtotal'));assert.ok(line);assert.ok(!line.includes('$'));assert.match(line,/account and currency scope are unverified/);assert.match(line,/not a whole-account broker profit report/);
});

test('legacy diagnostic subtotal cannot revive unknown position profit in allocation arithmetic',()=>{
 const arg=input([row(1,null)]);arg.liveSnapshot.reconciliation={snapshotSummedPL:50,equityMinusBalancePL:null,discrepancy:null,exceedsThreshold:false,excludedCount:0,brokerAbsentExcludedCount:0,stalePLCount:1};
 const result=wire(compose(arg));assert.equal(result.floatingPnL,null);assert.equal(result.liveEquity,1020);assert.equal(result.monetaryScopeVerified,false);
});
