import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveAccountEventBus as bus } from '../liveAccountEventBus.js';
import { createSharedAccountChangeStream, resolveSharedAccountChangeScope } from '../sharedAccountChangeStream.js';
const flush = async () => { for (let i=0;i<50;i++) await Promise.resolve(); };
const user = { id: 7, role: 'USER' };
function scopeHarness() {
  let session: typeof user | null = user;
  let pin: number | null = 81;
  let allocation = true;
  let capturedPin = 81;
  const dependencies = { readSession: async () => session, readView: async () => ({ pool: { masterConnectionId: capturedPin }, hasAllocation: allocation }), readPin: async () => pin };
  return { dependencies, session: (v: typeof session) => {session=v;}, pin: (v: typeof pin) => {pin=v;}, allocation: (v:boolean)=>{allocation=v;}, capturedPin:(v:number)=>{capturedPin=v;} };
}
test('authorization requires same session user and current pinned pool; preview cannot upgrade', async () => {
  const h=scopeHarness(); const read=()=>resolveSharedAccountChangeScope(7, false, h.dependencies);
  assert.equal(await read(),81);
  h.allocation(false); h.session({id:7,role:'OWNER'}); assert.equal(await read(),null);
  assert.equal(await resolveSharedAccountChangeScope(7,true,h.dependencies),81);
  h.session({id:7,role:'USER'}); assert.equal(await resolveSharedAccountChangeScope(7,true,h.dependencies),null);
  h.allocation(true); h.session({id:8,role:'OWNER'}); assert.equal(await read(),null);
  h.session(null); assert.equal(await read(),null);
  h.session(user); h.pin(82); assert.equal(await read(),null);
  h.capturedPin(82); assert.equal(await read(),82);
});
test('logout or role downgrade during allocation read rejects hints', async () => {
  for (const replacement of [null,{id:7,role:'USER'},{id:8,role:'OWNER'}]) {
    let session: typeof user|null={id:7,role:'OWNER'};
    assert.equal(await resolveSharedAccountChangeScope(7,true,{readSession:async()=>session,readView:async()=>{session=replacement;return{pool:{masterConnectionId:81},hasAllocation:false};},readPin:async()=>81}),null);
  }
});
test('connection channel is distinct from user channel and listener failures are isolated', () => {
  let count=0; const good=()=>count++; const bad=()=>{throw Error('viewer');}; const own=()=>{throw Error('wrong channel');};
  bus.on(81,own); bus.onConnection(81,bad); bus.onConnection(81,good);
  try { bus.emitConnection(82); assert.equal(count,0); bus.emitConnection(81); assert.equal(count,1); bus.offConnection(81,good); bus.emitConnection(81); assert.equal(count,1); }
  finally {bus.off(81,own);bus.offConnection(81,bad);bus.offConnection(81,good);}
});
test('binding subscribes before first hint; bursts during authorization coalesce with trailing read', async () => {
  let calls=0, active=0, max=0, hints=0; let release: (()=>void)|null=null; let hold=false;
  const stream=createSharedAccountChangeStream({bus,readScope:async()=>{calls++;active++;max=Math.max(max,active);if(hold) await new Promise<void>(r=>{release=r;});active--;return 81;},sendHint:()=>{hints++;if(hints===1)bus.emitConnection(81);},schedulerOptions:{minGapMs:0}});
  stream.request(); await flush(); assert.equal(hints,2); assert.equal(calls,2);
  hold=true; bus.emitConnection(81); await flush(); for(let i=0;i<100;i++)bus.emitConnection(81);
  assert.equal(calls,3); hold=false; release!(); await flush(); assert.equal(calls,4); assert.equal(max,1); assert.equal(hints,4); stream.stop();
});
test('pin switch rejects queued old-pin event, revocation/read failure unbind, regrant and close safe', async () => {
  let pin:number|null=81; let hints=0; let fail=false;
  const stream=createSharedAccountChangeStream({bus,readScope:async()=>{if(fail)throw Error('scope');return pin;},sendHint:()=>hints++,schedulerOptions:{minGapMs:0}});
  stream.request();await flush();assert.equal(hints,1);
  pin=82;bus.emitConnection(81);await flush();assert.equal(hints,2);
  bus.emitConnection(81);await flush();assert.equal(hints,2);
  bus.emitConnection(82);await flush();assert.equal(hints,3);
  pin=null;bus.emitConnection(82);await flush();assert.equal(hints,3);
  pin=82;bus.emitConnection(82);await flush();assert.equal(hints,3);stream.request();await flush();assert.equal(hints,4);
  fail=true;bus.emitConnection(82);await flush();fail=false;bus.emitConnection(82);await flush();assert.equal(hints,4);
  stream.request();await flush();assert.equal(hints,5);stream.stop();bus.emitConnection(82);stream.request();await flush();assert.equal(hints,5);
});
test('close during an awaited scope never subscribes or emits',async()=>{
 let release!:(value:number)=>void;let hints=0;
 const stream=createSharedAccountChangeStream({bus,readScope:()=>new Promise<number>(r=>release=r),sendHint:()=>hints++,schedulerOptions:{minGapMs:0}});
 stream.request();stream.stop();release(81);await flush();bus.emitConnection(81);await flush();assert.equal(hints,0);
});
test('logout during awaited pin read is checked before scope returns', async () => {
  let session:typeof user|null=user;
  assert.equal(await resolveSharedAccountChangeScope(7,false,{readSession:async()=>session,readView:async()=>({pool:{masterConnectionId:81},hasAllocation:true}),readPin:async()=>{session=null;return 81;}}),null);
});
