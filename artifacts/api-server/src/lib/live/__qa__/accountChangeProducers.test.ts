import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';
const source=readFileSync(process.env.ARX_ACCOUNT_PRODUCER_SOURCE ?? new URL('../../../routes/mt5.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('mt5.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const flush=async()=>{for(let i=0;i<30;i++)await Promise.resolve();};
const blocks:ts.Block[]=[];
function visit(n:ts.Node){if(ts.isBlock(n))blocks.push(n);ts.forEachChild(n,visit);}visit(tree);
const declarations=blocks.flatMap(block=>block.statements.flatMap((statement,i)=>ts.isVariableStatement(statement)&&statement.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text==='persistedAccount')?[{statement,next:block.statements[i+1]}]:[]));
// Transform only the DB call into a deferred write seam. Keep production
// await/guard/emitter ordering, so moving an emit ahead of persistence fails.
function writeFragment(statement:ts.Statement,next:ts.Statement){
 const result=ts.transform(statement,[context=>root=>{
  const walk=(node:ts.Node):ts.Node=>ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='updateConnection'
   ?ts.factory.createCallExpression(ts.factory.createIdentifier('write'),undefined,[]):ts.visitEachChild(node,walk,context);
  return ts.visitNode(root,walk) as ts.Statement;
 }]);
 const printer=ts.createPrinter();const text=printer.printNode(ts.EmitHint.Unspecified,result.transformed[0],tree)+'\n'+next.getText(tree);result.dispose();return text;
}
test('both persisted account writers emit connection hints only after a returned row',async()=>{
 assert.equal(declarations.length,2,'heartbeat and sync-account must each signal persisted connection account writes');
 for(const row of declarations){
  assert.match(row.next.getText(tree),/if \(persistedAccount\) emitConnectionAccountChanged\(persistedAccount.id\)/);
  for(const outcome of [{id:81},null,'reject'] as const){
   const emitted:number[]=[];let resolve!:(v:unknown)=>void;let reject!:(e:Error)=>void;
   const write=()=>new Promise((r,j)=>{resolve=r;reject=j;});
   const js=ts.transpileModule('(async()=>{'+writeFragment(row.statement,row.next)+'})()', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
   const done=vm.runInNewContext(js,{write,emitConnectionAccountChanged:(id:number)=>emitted.push(id)}) as Promise<void>;
   await flush();assert.deepEqual(emitted,[]);
   if(outcome==='reject'){reject(Error('persist failed'));await assert.rejects(done);}else{resolve(outcome);await done;}
   assert.deepEqual(emitted,outcome && outcome!=='reject'?[81]:[]);
  }
 }
});
test('existing recompute/reconciliation blocks emit trailing hints only after both complete',async()=>{
 const work=blocks.filter(block=>block.statements.some(s=>ts.isVariableStatement(s)&&s.declarationList.declarations.some(d=>ts.isIdentifier(d.name)&&d.name.text==='recomputedPool')));
 assert.equal(work.length,2);
 for(const block of work){
  const text=block.getText(tree).replace('await import("../lib/live/masterBridgePool.js")','await poolModule()').replace('await import("./adminAllocations.js")','await allocationModule()');
  for(const success of [true,false]){
   const emitted:number[]=[];let finishPool!:(v:unknown)=>void;let finishAllocation!:()=>void;
   const done=vm.runInNewContext(ts.transpileModule('(async()=>'+text+')()',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{
    poolModule:async()=>({recomputeMasterPool:()=>new Promise(r=>finishPool=r)}),
    allocationModule:async()=>({autoReconcileSettledAllocations:()=>new Promise<void>(r=>finishAllocation=r)}),
    emitConnectionAccountChanged:(id:number)=>emitted.push(id),
   }) as Promise<void>;
   await flush();assert.deepEqual(emitted,[]);finishPool({ok:success,masterConnectionId:81});await flush();assert.deepEqual(emitted,[]);finishAllocation();await done;assert.deepEqual(emitted,success?[81]:[]);
  }
 }
});
