// Executes the real GET and role gate with offline dependencies, no server/DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {operatorRoleFromSession} from '../../lib/security/adminRoleGate.js';
const source=readFileSync(new URL('../adminFundBook.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('adminFundBook.ts',source,ts.ScriptTarget.Latest,true);
const call=tree.statements.map(n=>ts.isExpressionStatement(n)?n.expression:null).find(n=>n&&ts.isCallExpression(n)&&n.expression.getText(tree)==='router.get'&&n.arguments[0]?.getText(tree)==='"/admin/fundbook/broker-mirror"');
assert.ok(call&&ts.isCallExpression(call));assert.equal(call.arguments[1]?.getText(tree),'requireUser');
const gate=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='requireAdmin');assert.ok(gate);
const code=ts.transpileModule(gate.getText(tree)+'\nconst handler='+call.arguments.at(-1)!.getText(tree),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const legacy={bridgeConnectionId:11,userId:23,accountBalance:1000,accountEquity:1005,floatingPlTotal:5,accountCurrency:'USD',freshness:'LIVE'};
const report=(balance='9007199254740993.123')=>({status:'reported',currentVerified:false,reason:'CLOCK_AND_CONTINUITY_UNVERIFIED',observedAt:'2026-11-02T12:00:00.000Z',receivedAt:'2026-11-02T12:00:01.000Z',observationAgeMs:1000,currency:'KWD',currencyDigits:3,amounts:{balance,equity:'1200.000',profit:'-12.345',credit:'212.345',margin:'0.000',freeMargin:'1200.000'}});
async function run(role:string|null,value:unknown=report()){
 let status=200,output:any,reads=0,nativeReads=0,seeds=0;
 const deps={operatorRoleFromSession,getBrokerMirror:async()=>{reads++;return {bridges:[legacy],positions:[]};},ensurePools:async()=>{seeds++;},appendAdminNativeAccountReports:async(rows:unknown[])=>{nativeReads++;assert.deepEqual(rows,[legacy]);return rows.map(row=>({...row as object,nativeAccountReport:value}));}};
 const handler=new Function(...Object.keys(deps),code+';return handler;')(...Object.values(deps));
 const res:any={status:(n:number)=>{status=n;return res;},json:(v:unknown)=>{output=v;}};
 await handler({authUser:role?{id:1,role}:undefined,query:{userId:99,bridgeConnectionId:99}},res);
 return {status,output,reads,nativeReads,seeds};
}
test('admin read appends exact native amounts without replacing legacy arithmetic',async()=>{const r=await run('ADMIN');assert.equal(r.status,200);assert.equal(r.nativeReads,1);assert.deepEqual(r.output.bridges[0],{...legacy,nativeAccountReport:report()});});
test('owner reread forwards a changed report rather than memoizing old money',async()=>{const first=await run('OWNER'),next=await run('OWNER',report('800.000'));assert.notEqual(first.output.bridges[0].nativeAccountReport?.amounts.balance,next.output.bridges[0].nativeAccountReport?.amounts.balance);});
test('read-only broker mirror never seeds pools',async()=>{const r=await run('ADMIN');assert.equal(r.seeds,0);});
for(const role of [null,'USER','INVESTOR','ADMIN_PREVIEW'])test(`unauthorized ${role} cannot read mirror or report or seed pools`,async()=>{const r=await run(role);assert.equal(r.status,role?403:401);assert.equal(r.reads,0);assert.equal(r.nativeReads,0);assert.equal(r.seeds,0);});
test('latest rejected report remains unavailable despite fresh legacy fields',async()=>{const value={...report(),status:'unavailable',reason:'ACCOUNT_REPORT_REJECTED',amounts:null};const r=await run('ADMIN',value);assert.deepEqual(r.output.bridges[0].nativeAccountReport,value);});
