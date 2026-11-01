import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import vm from "node:vm";
import ts from "typescript";
import { createSharedAccountChangeStream, resolveSharedAccountChangeScope, resolveAccountStreamAuthorization } from "../sharedAccountChangeStream.js";
import { createAccountSnapshotScheduler } from "../accountSnapshotScheduler.js";

// Execute the actual route body with read-only data/transport seams. No DB,
// credentials, server or broker. This supplements the scheduler's clock tests;
// it detects a route accidentally bypassing the scheduler or subscribing late.
const source = readFileSync(process.env.ARX_ACCOUNT_STREAM_SOURCE ?? new URL("../../../routes/meLive.ts", import.meta.url), "utf8");
const begin = source.indexOf('router.get("/me/live/account-stream"');
assert.notEqual(begin, -1);
const route = source.slice(begin, source.indexOf("\n});", begin) + 4)
  .replace('await import("../lib/live/liveAccountSnapshot.js")', "await snapshotModule()")
  .replace('await import("../lib/live/liveAccountEventBus.js")', "await busModule()");
const js = ts.transpileModule(route, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function harness(delayModule = false, initialAdmin = false, master: number | null = null, live = false) {
  let pinned = master;
  let allocated = master != null;
  let failSession = false;
  const req = Object.assign(new EventEmitter(), { cookies: { arx_user_session: "fixture-session" } });
  let session: {id:number;role:string} | null = {id:7,role:initialAdmin ? "OWNER" : "USER"};
  let ended = false;
  const scopes: boolean[] = [];
  const emitter = new EventEmitter();
  const bus = Object.assign(emitter, {
    onConnection(id:number, listener:()=>void) { emitter.on(`c:${id}`,listener); },
    offConnection(id:number, listener:()=>void) { emitter.off(`c:${id}`,listener); },
  });
  const writes: string[] = [];
  const intervals = new Map<number, () => void>();
  let handler!: (req: unknown, res: unknown) => Promise<void>;
  let finishModule!: (value: object) => void;
  let reads = 0; let active = 0; let maxActive = 0;
  const releases: Array<() => void> = [];
  const context = {
    router: { get: (_path: string, _auth: unknown, fn: typeof handler) => { handler = fn; } },
    requireUser: () => {}, uid: () => 7, isAdmin: () => initialAdmin,
    USER_SESSION_COOKIE: "arx_user_session", findUserBySessionToken: async (_token:string, options?:{readOnly?:boolean}) => { assert.equal(options?.readOnly,true); if (failSession) throw Error("session unavailable"); return session; },
    resolveAccountStreamAuthorization, resolveSharedAccountChangeScope,
    createSharedAccountChangeStream: (options:Parameters<typeof createSharedAccountChangeStream>[0]) => createSharedAccountChangeStream({...options,schedulerOptions:{minGapMs:0}}),
    getUserAllocationView: async () => ({pool:pinned == null ? null : {masterConnectionId:pinned},hasAllocation:allocated}), resolveActiveMasterConnectionId: async () => pinned,
    snapshotModule: () => delayModule ? new Promise(resolve => { finishModule = resolve; }) : Promise.resolve({buildLiveAccountSnapshot:()=>({balance:100,privateFixture:true})}),
    busModule: async () => ({ liveAccountEventBus: bus }),
    createAccountSnapshotScheduler: (read: () => Promise<void>) => createAccountSnapshotScheduler(read, { minGapMs: 0 }),
    getUserModeScope: async (_id:number, options:{isAdmin:boolean}) => { scopes.push(options.isAdmin); return { currentAccountMode: live ? "LIVE_SHARED" : "DEMO" }; },
    resolveLivePositionVisibility: () => ({ includeLive: live, notLiveReason: "not live" }),
    selectLiveOpenPositions:async()=>[], livePositionColumns:{}, getUserAccountConnection:async()=>null, accountFiguresOf:()=>null, connectionAccountSnapshot:()=>null,
    fetchInvestorBalanceParts: async () => {
      reads++; active++; maxActive = Math.max(maxActive, active);
      await new Promise<void>(resolve => releases.push(resolve)); active--;
      return {};
    },
    composeInvestorBalance: () => ({ source: "demo" }),
    toInvestorLiveBalanceWire: (value: unknown) => value,
    setInterval: (fn: () => void, ms: number) => { intervals.set(ms, fn); return ms; },
    clearInterval: (id: number) => { intervals.delete(id); },
    setTimeout, clearTimeout,
  };
  vm.runInNewContext(js, context);
  const response = { setHeader() {}, flushHeaders() {}, write: (value: string) => writes.push(value), end: () => { ended=true; } };
  const run = handler(req, response);
  return {
    pin: (id:number|null)=>{pinned=id;}, allocation:(value:boolean)=>{allocated=value;}, failSession:()=>{failSession=true;},
    run, req, bus, writes, intervals, scopes, ended: () => ended, session: (value:typeof session) => {session=value;},
    finishModule: () => finishModule({}),
    reads: () => reads, maxActive: () => maxActive,
    release: () => { const done = releases.shift(); assert.ok(done); done(); },
  };
}

test("an update during the initial account read earns a trailing refresh", async () => {
  const h = harness(); await flush();
  try {
    assert.equal(h.reads(), 1);
    assert.equal(h.bus.listenerCount("7"), 1);
    h.bus.emit("7"); h.release(); await flush();
    assert.equal(h.reads(), 2);
    h.release(); await flush();
    assert.equal(h.writes.length, 2);
  } finally { h.req.emit("close"); }
});

test("fallback ticks cannot overlap an event-driven refresh", async () => {
  const h = harness(); await flush(); h.release(); await flush();
  try {
    h.bus.emit("7"); await flush();
    assert.equal(h.reads(), 2);
    h.intervals.get(3000)!(); await flush();
    assert.equal(h.maxActive(), 1);
    assert.equal(h.reads(), 2);
    h.release(); await flush();
    assert.equal(h.reads(), 3);
    h.release(); await flush();
  } finally { h.req.emit("close"); }
});

test("disconnect during module loading never starts reads or subscriptions", async () => {
  const h = harness(true); h.req.emit("close"); h.finishModule(); await flush();
  assert.equal(h.reads(), 0);
  assert.equal(h.bus.listenerCount("7"), 0);
  assert.equal(h.intervals.size, 0);
});

test("disconnect during a read suppresses writes and trailing work", async () => {
  const h = harness(); await flush();
  h.bus.emit("7"); h.req.emit("close"); h.release(); await flush();
  assert.equal(h.reads(), 1);
  assert.equal(h.bus.listenerCount("7"), 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.writes.length, 0);
});

for (const changedSession of [null, {id:8,role:"OWNER"}]) {
  test(`revoked/replaced session during pending read closes stream without monetary payload: ${changedSession?.id ?? 'revoked'}`, async () => {
    const h=harness();await flush();assert.equal(h.reads(),1);
    h.session(changedSession);h.release();await flush();
    assert.equal(h.writes.length,0);assert.equal(h.ended(),true);assert.equal(h.bus.listenerCount("7"),0);assert.equal(h.intervals.size,0);
  });
}
test('role downgrade during pending monetary read discards privileged result and rebuilds under user gate',async()=>{
 const h=harness(false,true);await flush();assert.deepEqual(h.scopes,[true]);
 h.session({id:7,role:'USER'});h.release();await flush();assert.equal(h.writes.length,0);assert.deepEqual(h.scopes,[true,false]);
 h.release();await flush();assert.equal(h.writes.length,1);h.req.emit('close');
});
test('initial effective user cap survives a persisted owner role',async()=>{
 const h=harness();h.session({id:7,role:'OWNER'});await flush();assert.deepEqual(h.scopes,[false]);h.release();await flush();assert.equal(h.writes.length,1);h.req.emit('close');
});

test('actual route sends only empty authorized master hints and rebinds on fallback pin change',async()=>{
 const h=harness(false,false,81);await flush();
 const hints=()=>h.writes.map(x=>JSON.parse(x.slice(6))).filter(x=>x.type==='shared_account_changed');
 assert.deepEqual(hints(),[{type:'shared_account_changed'}]);assert.equal(h.bus.listenerCount('c:81'),1);
 h.bus.emit('c:82');await flush();assert.equal(hints().length,1);
 h.bus.emit('c:81');await flush();assert.equal(hints().length,2);
 h.pin(82);h.intervals.get(3000)!();await flush();assert.equal(h.bus.listenerCount('c:81'),0);assert.equal(h.bus.listenerCount('c:82'),1);assert.equal(hints().length,3);
 h.allocation(false);h.bus.emit('c:82');await flush();assert.equal(hints().length,3);assert.equal(h.bus.listenerCount('c:82'),0);
 h.req.emit('close');h.release();await flush();assert.equal(h.intervals.size,0);
});
test('failed current session lookup closes whole stream and removes shared subscription',async()=>{
 const h=harness(false,false,81);await flush();assert.equal(h.bus.listenerCount('c:81'),1);
 h.failSession();h.bus.emit('c:81');await flush();assert.equal(h.ended(),true);assert.equal(h.bus.listenerCount('c:81'),0);assert.equal(h.bus.listenerCount('7'),0);
 const count=h.writes.length;h.release();await flush();assert.equal(h.writes.length,count);
});

for(const revoke of [true,false]){
 test(`LIVE monetary result rechecks authorization after final awaited read (${revoke?'logout':'downgrade'})`,async()=>{
  const h=harness(false,true,null,true);await flush();assert.equal(h.reads(),1);
  h.session(revoke?null:{id:7,role:'USER'});h.release();await flush();assert.equal(h.writes.length,0);
  if(revoke){assert.equal(h.ended(),true);}else{assert.deepEqual(h.scopes,[true,false]);h.release();await flush();assert.equal(h.writes.length,1);}
  h.req.emit('close');
 });
}
