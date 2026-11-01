import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as module from '../sharedAccountChangeStream.js';
import { liveAccountEventBus as bus } from '../liveAccountEventBus.js';
const flush = async () => { for (let i = 0; i < 70; i++) await Promise.resolve(); };
const user = { id: 7, role: 'USER' };
const resolve = (...args: any[]) => {
  const fn = (module as any).resolvePersonalAccountChangeScope;
  assert.equal(typeof fn, 'function', 'personal scope resolver must exist');
  return fn(...args);
};
test('personal scope uses exact signed-in user and distinguishes authorized empty selection', async () => {
  const ids: number[] = [];
  const deps = { readSession: async () => user, readConnection: async (id: number) => { ids.push(id); return { id: 81, userId: 7 }; } };
  assert.deepEqual(await resolve(7, deps), { connectionId: 81 }); assert.deepEqual(ids, [7]);
  assert.deepEqual(await resolve(7, { ...deps, readConnection: async () => null }), { connectionId: null });
  assert.deepEqual(await resolve(7, { ...deps, readSession: async () => ({ id: 7, role: 'OWNER' }) }), { connectionId: 81 });
});
test('foreign connection and invalid identity are never hints for another account', async () => {
  for (const connection of [{ id: 81, userId: 8 }, { id: 81, userId: null }, { id: 0, userId: 7 }, { id: NaN, userId: 7 }])
    assert.equal(await resolve(7, { readSession: async () => user, readConnection: async () => connection }), null);
});
test('invalid initial session reads no connection; logout or replacement after awaited selection refuses', async () => {
  let reads = 0;
  assert.equal(await resolve(7, { readSession: async () => null, readConnection: async () => { reads++; return null; } }), null);
  assert.equal(reads, 0);
  for (const after of [null, { id: 8, role: 'OWNER' }]) {
    let session: typeof user | null = user;
    assert.equal(await resolve(7, { readSession: async () => session, readConnection: async () => { session = after; return { id: 81, userId: 7 }; } }), null);
  }
});
test('authorized empty scope invalidates after unbinding, repeats on reconciliation and ignores old connection events', async () => {
  let scope: any = { connectionId: 81 }, hints = 0;
  const stream = module.createSharedAccountChangeStream({ bus, readScope: async () => scope,
    sendHint: () => { hints++; }, schedulerOptions: { minGapMs: 0 } });
  try {
    stream.request(); await flush(); assert.equal(hints, 1);
    scope = { connectionId: null }; bus.emitConnection(81); await flush(); assert.equal(hints, 2);
    bus.emitConnection(81); await flush(); assert.equal(hints, 2);
    stream.request(); await flush(); assert.equal(hints, 3);
    scope = { connectionId: 82 }; stream.request(); await flush(); assert.equal(hints, 4);
    bus.emitConnection(81); await flush(); assert.equal(hints, 4);
    bus.emitConnection(82); await flush(); assert.equal(hints, 5);
    scope = null; stream.request(); await flush(); assert.equal(hints, 5);
  } finally { stream.stop(); }
});
test('first authorized empty selection emits a clearing hint but denied scope never does', async () => {
  for (const [scope, expected] of [[{ connectionId: null }, 1], [null, 0]] as const) {
    let hints = 0;
    const stream = module.createSharedAccountChangeStream({ bus, readScope: async () => scope as any, sendHint: () => { hints++; }, schedulerOptions: { minGapMs: 0 } });
    try { stream.request(); await flush(); assert.equal(hints, expected); } finally { stream.stop(); }
  }
});
test('personal scope errors unbind and recover only through a later authorized check', async () => {
  let fail = false, hints = 0;
  const stream = module.createSharedAccountChangeStream({ bus, readScope: async () => { if (fail) throw Error('lookup'); return { connectionId: 81 } as any; }, sendHint: () => { hints++; }, schedulerOptions: { minGapMs: 0 } });
  try {
    stream.request(); await flush(); fail = true; bus.emitConnection(81); await flush(); assert.equal(hints, 1);
    fail = false; bus.emitConnection(81); await flush(); assert.equal(hints, 1);
    stream.request(); await flush(); assert.equal(hints, 2);
    stream.stop(); bus.emitConnection(81); stream.request(); await flush(); assert.equal(hints, 2);
  } finally { stream.stop(); }
});
test('queued old events during selection read stay serialized and do not resurrect a cleared binding', async () => {
  let scope: any = { connectionId: 81 }, hints = 0, reads = 0, active = 0, max = 0, hold = false;
  let release!: () => void;
  const stream = module.createSharedAccountChangeStream({ bus, readScope: async () => {
    reads++; active++; max = Math.max(max, active);
    if (hold) await new Promise<void>(r => { release = r; }); active--; return scope;
  }, sendHint: () => { hints++; if (hints === 1) bus.emitConnection(81); }, schedulerOptions: { minGapMs: 0 } });
  try {
    stream.request(); await flush(); assert.equal(hints, 2); // Subscription before initial hint.
    hold = true; bus.emitConnection(81); await flush();
    for (let i = 0; i < 40; i++) bus.emitConnection(81);
    scope = { connectionId: null }; hold = false; release(); await flush();
    assert.equal(max, 1); assert.equal(reads, 4); assert.equal(hints, 3);
    bus.emitConnection(81); await flush(); assert.equal(hints, 3);
  } finally { stream.stop(); }
});
