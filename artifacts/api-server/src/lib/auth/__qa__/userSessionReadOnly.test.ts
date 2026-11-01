import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(process.env.ARX_SESSION_SOURCE ?? new URL('../userSessions.ts', import.meta.url),'utf8');
const tree=ts.createSourceFile('userSessions.ts',source,ts.ScriptTarget.Latest,true);
const declaration=tree.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='findUserBySessionToken');
assert.ok(declaration);
const js=ts.transpileModule(declaration.getText(tree).replace(/^export /,'')+'\nglobalThis.lookup=findUserBySessionToken;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function harness(expired=false, missing=false){
 const user={id:7,role:'USER'};let reads=0,writes=0;const predicates:unknown[]=[];
 const db={select:()=>{reads++;return{from:()=>({innerJoin:()=>({where:(condition:unknown)=>{predicates.push(condition);return{limit:async()=>missing?[]:[{user,session:{expiresAt:new Date(Date.now()+(expired?-1000:60000))}}]};}})})};},
 delete:()=>{writes++;return{where:async()=>{}};},update:()=>{writes++;return{set:()=>({where:async()=>{}})};}};
 const context=vm.createContext({db,usersTable:{id:'uid'},authUserSessionsTable:{userId:'userId',tokenHash:'tokenHash'},eq:(left:unknown,right:unknown)=>[left,right],hashToken:(raw:string)=>createHash('sha256').update(raw).digest('hex')});
 vm.runInContext(js,context);
 return {lookup:(context.lookup as (token:string,options?:{readOnly?:boolean})=>Promise<typeof user|null>),reads:()=>reads,writes:()=>writes,predicates,user};
}
for(const expired of [false,true]){
 test(`read-only session lookup preserves authorization and performs no writes (expired=${expired})`,async()=>{
  const h=harness(expired);assert.equal(await h.lookup('fixture-session',{readOnly:true}),expired?null:h.user);assert.equal(h.reads(),1);assert.equal(h.writes(),0);
  assert.deepEqual(h.predicates,[['tokenHash',createHash('sha256').update('fixture-session').digest('hex')]]);
 });
 test(`legacy session lookup retains existing touch/cleanup (expired=${expired})`,async()=>{
  const h=harness(expired);assert.equal(await h.lookup('fixture-session'),expired?null:h.user);assert.equal(h.writes(),1);
 });
}
test('read-only lookup never accepts missing/revoked sessions or empty tokens',async()=>{
 const h=harness(false,true);assert.equal(await h.lookup('fixture-session',{readOnly:true}),null);assert.equal(h.reads(),1);assert.equal(h.writes(),0);
 assert.equal(await h.lookup('',{readOnly:true}),null);assert.equal(h.reads(),1);
});
