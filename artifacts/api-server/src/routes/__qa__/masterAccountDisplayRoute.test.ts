// Executes the actual master-display builder; database/provider dependencies are
// inert doubles. This is wiring/evidence coverage, not a running HTTP/API claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { projectPinnedMasterAccount } from '../../lib/live/masterAccountDisplay.js';
const source=readFileSync(new URL('../meSharedAccount.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('meSharedAccount.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const node=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='buildMasterMt5Snapshot');assert.ok(node);
const compiled=ts.transpileModule(node.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const NOW=Date.parse('2026-11-01T12:00:00Z');
const facts=(over:Record<string,unknown>={})=>({id:7,userId:23,accountNumber:'12345678',brokerName:'Fixture broker',serverName:'Fixture server',accountCurrency:'USD',accountType:'demo',accountBalance:100,accountEquity:120,margin:5,freeMargin:115,accountSyncedAt:new Date(NOW-1000),lastHeartbeat:new Date(NOW),...over});
const pool={masterConnectionId:7,mt5Balance:9999,mt5Equity:9999,mt5UsedMargin:999,mt5FreeMargin:9999,accountCurrency:'WRONG',snapshotStatus:'FRESH',snapshotAgeMs:0,lastMt5SnapshotAt:new Date(NOW),isOverAllocated:false};
async function run(connection:ReturnType<typeof facts>|null, nativeReport:unknown=null){
 const ids:number[]=[],positions:unknown[]=[],nativeScopes:unknown[]=[],view={pool,assignedAllocation:10,availableAllocation:8,reservedRisk:2};
 let resolveCalls=0;
 const deps={Date:class extends Date{constructor(value?:string|number|Date){super(value===undefined?NOW:value instanceof Date?value.getTime():value);}static now(){return NOW;}},getUserAllocationView:async()=>view,resolveActiveMasterConnectionId:async()=>{resolveCalls++;return99();},getConnection:async(id:number)=>{ids.push(id);return connection;},countOpenPositions:async(scope:unknown)=>{positions.push(scope);return 0;},round2:(n:number)=>Math.round(n*100)/100,projectPinnedMasterAccount,loadNativeAccountReport:async(c:unknown)=>{nativeScopes.push({connection:c});return nativeReport;},db:{select:()=>({from:()=>({where:async()=>[{sum:0,count:0}]})})},sql:()=>null,and:()=>null,eq:()=>null,sharedTradeAttributionTable:{},unattributedMasterTradesTable:{}};
 function return99(){return 99;}
 const build=new Function(...Object.keys(deps),compiled+';return buildMasterMt5Snapshot;')(...Object.values(deps));
 return {snapshot:await build(1,view),ids,positions,resolveCalls,nativeScopes};
}
test('master display binds metadata, money and positions to the allocation view pin once',async()=>{
 const r=await run(facts());assert.deepEqual(r.ids,[7]);assert.equal(r.resolveCalls,0);assert.equal(r.snapshot.mt5Balance,100);assert.equal(r.snapshot.mt5Equity,120);assert.equal(r.snapshot.accountCurrency,'USD');assert.equal(r.snapshot.accountNumberMasked,'••••5678');assert.deepEqual(r.positions,[{userId:23,venue:'LIVE',basis:'EXPOSURE',bridgeConnectionId:7}]);
});
test('fresh generic heartbeat never upgrades an old monetary update',async()=>{
 const r=await run(facts({accountSyncedAt:new Date(NOW-120000)}));assert.equal(r.snapshot.snapshotStatus,'STALE');assert.equal(r.snapshot.syncStatus,'STALE');assert.equal(r.snapshot.snapshotAgeMs,120000);assert.equal(r.snapshot.lastMt5SnapshotAt,new Date(NOW-120000).toISOString());assert.equal(r.snapshot.mt5Balance,100);
});
test('never-synced database zero defaults are unavailable rather than live money',async()=>{
 const r=await run(facts({accountSyncedAt:null,accountBalance:0,accountEquity:0}));for(const name of ['mt5Balance','mt5Equity','mt5UsedMargin','mt5FreeMargin','mt5OpenPnl'])assert.equal(r.snapshot[name],null);assert.equal(r.snapshot.snapshotStatus,'MISSING');assert.equal(r.snapshot.lastMt5SnapshotAt,null);
});
test('future account timestamps cannot become live evidence',async()=>{
 const r=await run(facts({accountSyncedAt:new Date(NOW+1)}));assert.equal(r.snapshot.snapshotStatus,'MISSING');assert.equal(r.snapshot.mt5Balance,null);assert.equal(r.snapshot.snapshotAgeMs,null);
});
test('missing pinned connection does not report fabricated zero positions or pool money',async()=>{
 const r=await run(null);assert.equal(r.snapshot.openPositions,null);assert.equal(r.snapshot.mt5Balance,null);assert.equal(r.snapshot.snapshotStatus,'MISSING');assert.deepEqual(r.positions,[]);
});
test('real account zero remains zero while no paired observation is invented',async()=>{
 const r=await run(facts({accountBalance:0,accountEquity:0,margin:0,freeMargin:0}));assert.equal(r.snapshot.mt5Balance,0);assert.equal(r.snapshot.mt5Equity,0);assert.equal(r.snapshot.mt5OpenPnl,null);assert.equal(r.snapshot.openPositions,0);
});

test('summary uses one allocation view for both master identity and user allocation',async()=>{
 let handler:ts.Node|undefined;function visit(n:ts.Node){if(ts.isCallExpression(n)&&n.expression.getText(tree)==='router.get'&&ts.isStringLiteral(n.arguments[0]!)&&n.arguments[0]!.text==='/me/shared-account/summary')handler=n.arguments.at(-1);ts.forEachChild(n,visit);}visit(tree);assert.ok(handler);
 const code=ts.transpileModule('const handler='+handler.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 let reads=0,output:any;const view={pool,assignedAllocation:10,availableAllocation:8,reservedRisk:2,openFloatingLoss:0,bridgeAvailability:'HEALTHY',bridgeMessage:'fixture',hasAllocation:true};
 const query:any={from:()=>query,leftJoin:()=>query,where:()=>query,groupBy:()=>query,then:(resolve:(rows:unknown[])=>unknown)=>Promise.resolve([]).then(resolve)};
 const deps={db:{select:()=>query},virtualTradingAccountsTable:{},sharedMasterAccountsTable:{},sharedTradeAttributionTable:{},sql:()=>null,and:()=>null,eq:()=>null,isNotNull:()=>null,ne:()=>null,getUserAllocationView:async()=>{reads++;return view;},isAdminOrOwner:()=>true,buildMasterMt5Snapshot:async(userId:number,supplied:unknown)=>{assert.equal(userId,1);assert.equal(supplied,view);return{arxAllocated:view.assignedAllocation};}};
 const fn=new Function(...Object.keys(deps),code+';return handler;')(...Object.values(deps));
 const res={json:(value:unknown)=>{output=value;},status:()=>{throw new Error('unexpected summary error');}};
 await fn({authUser:{id:1}},res);assert.equal(reads,1);assert.equal(output.masterMt5.arxAllocated,output.allocationView.assignedAllocation);
});

test('separate positions route still resolves its own pin and handles unpinned master without a pool dependency',async()=>{
 let handler:ts.Node|undefined;function visit(n:ts.Node){if(ts.isCallExpression(n)&&n.expression.getText(tree)==='router.get'&&ts.isStringLiteral(n.arguments[0]!)&&n.arguments[0]!.text==='/me/shared-account/positions')handler=n.arguments.at(-1);ts.forEachChild(n,visit);}visit(tree);assert.ok(handler);
 const code=ts.transpileModule('const handler='+handler.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 let reads=0,output:any;const deps={isAdminOrOwner:()=>true,resolveActiveMasterConnectionId:async()=>{reads++;return null;}};
 const fn=new Function(...Object.keys(deps),code+';return handler;')(...Object.values(deps));
 await fn({authUser:{id:1}},{json:(value:unknown)=>{output=value;},status:()=>{throw new Error('unexpected positions route failure');}});
 assert.equal(reads,1);assert.equal(output.note,'MASTER_BRIDGE_NOT_PINNED');assert.equal(output.masterConnectionId,null);
});


test('owner native report passes exact decimal text under captured pinned identity without overwriting allocation',async()=>{
 const conn=facts();const native={status:'reported',currentVerified:false,amounts:{balance:'9007199254740993.123',profit:'-5.125'}};
 const r=await run(conn,native);assert.deepEqual(r.nativeScopes,[{connection:conn}]);assert.strictEqual(r.snapshot.nativeAccountReport,native);assert.equal(r.snapshot.arxAllocated,10);assert.equal(r.snapshot.mt5OpenPnl,null);
});
test('mismatched loaded connection is not used for native money',async()=>{
 const r=await run(facts({id:8}));assert.deepEqual(r.nativeScopes,[{connection:null}]);assert.equal(r.snapshot.nativeAccountReport,null);assert.equal(r.snapshot.mt5Balance,null);
});

test('summary normal-user path never invokes native master reader',async()=>{
 let handler:ts.Node|undefined;function visit(n:ts.Node){if(ts.isCallExpression(n)&&n.expression.getText(tree)==='router.get'&&ts.isStringLiteral(n.arguments[0]!)&&n.arguments[0]!.text==='/me/shared-account/summary')handler=n.arguments.at(-1);ts.forEachChild(n,visit);}visit(tree);assert.ok(handler);
 const code=ts.transpileModule('const handler='+handler.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 let reads=0,output:any;const view={pool,assignedAllocation:10,availableAllocation:8,reservedRisk:2,openFloatingLoss:0,bridgeAvailability:'HEALTHY',bridgeMessage:'fixture',hasAllocation:true};
 const query:any={from:()=>query,leftJoin:()=>query,where:()=>query,groupBy:()=>query,then:(resolve:(rows:unknown[])=>unknown)=>Promise.resolve([]).then(resolve)};
 const deps={db:{select:()=>query},virtualTradingAccountsTable:{},sharedMasterAccountsTable:{},sharedTradeAttributionTable:{},sql:()=>null,and:()=>null,eq:()=>null,isNotNull:()=>null,ne:()=>null,getUserAllocationView:async()=>{reads++;return view;},isAdminOrOwner:()=>false,buildMasterMt5Snapshot:async()=>{throw new Error('master data must not be read');}};
 const fn=new Function(...Object.keys(deps),code+';return handler;')(...Object.values(deps));
 const res={json:(value:unknown)=>{output=value;},status:()=>{throw new Error('unexpected summary error');}};
 await fn({authUser:{id:1}},res);assert.equal(reads,1);assert.equal(output.masterMt5,null);assert.equal(output.masterAccess,false);assert.equal(output.allocationView.assignedAllocation,10);
});
