// Actual domain -> ingest -> latest-attempt reader -> status. Only persistence,
// provider side effects and connection discovery are offline doubles.
import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
const bridgeV2 = await import(new URL('../../../../../../lib/domain/src/bridge-v2/index.js', import.meta.url).href);
import { bridgeV2EventsTable, bridgeV2StreamStateTable } from '../../../../../../lib/db/src/schema/bridgeV2Events.js';
const NOW = Date.now() - 1000;
let events: any[] = [], states = new Map<string, any>(), emitted: number[] = [], queries: any[] = [], failCommit = false, failUpdate = false, failRejected = false, beforeCommit: (() => void) | null = null, nextId = 1;
const dialect = new PgDialect();
function filterRows(rows: any[], where: any) {
    const query = dialect.sqlToQuery(where);
    queries.push(query);
    const keys: Record<string, string> = { user_id: 'userId', bridge_connection_id: 'bridgeConnectionId', message_type: 'messageType', idempotency_key: 'idempotencyKey', accepted: 'accepted' };
    const matches = [...query.sql.matchAll(/"(user_id|bridge_connection_id|message_type|idempotency_key|accepted)" = \$(\d+)/g)];
    return rows.filter(row => matches.every(m => row[keys[m[1]!]] === query.params[Number(m[2]) - 1]) && (!query.sql.includes('"bridge_connection_id" is null') || row.bridgeConnectionId == null));
}
function insertEvent(rows: any[], row: any, ignoreConflict: boolean) {
    if (rows.some(e => e.userId === row.userId && e.idempotencyKey === row.idempotencyKey)) {
        if (ignoreConflict)
            return [];
        throw Object.assign(Error('unique conflict'), { code: '23505' });
    }
    const stored = { ...row, id: nextId++, createdAt: new Date(row.serverReceivedAtEpochMs ?? NOW) };
    rows.push(stored);
    return [{ id: stored.id }];
}
function eventInsert(rows: any[], row: any, outside = false) {
    const run = (ignore: boolean) => { if (outside && failRejected)
        throw Error('rejection persistence failed'); return insertEvent(rows, row, ignore); };
    return { then: (resolve: any, reject: any) => Promise.resolve().then(() => run(false)).then(resolve, reject), onConflictDoNothing: () => ({ returning: async () => run(true) }) };
}
const fakeDb = {
    insert: (table: unknown) => ({ values: (row: any) => { assert.equal(table, bridgeV2EventsTable); return eventInsert(events, row, true); } }),
    select: () => ({ from: (table: unknown) => ({ where: (where: any) => ({ orderBy: () => ({ limit: async (n: number) => { assert.equal(table, bridgeV2EventsTable); return filterRows(events, where).sort((a, b) => b.id - a.id).slice(0, n); } }) }) }) }),
    transaction: async (callback: (tx: any) => Promise<any>) => {
        const pendingEvents = [...events];
        const pendingStates = new Map([...states].map(([key, value]) => [key, { ...value }]));
        let key = '';
        const tx = {
            insert: (table: unknown) => ({ values: (row: any) => {
                    if (table === bridgeV2StreamStateTable) {
                        key = JSON.stringify([row.userId, row.bridgeConnectionId, row.messageType, row.streamKey]);
                        return { onConflictDoNothing: async () => { if (!pendingStates.has(key))
                                pendingStates.set(key, { ...row, lastSequence: null }); } };
                    }
                    assert.equal(table, bridgeV2EventsTable);
                    return eventInsert(pendingEvents, row);
                } }),
            select: () => ({ from: (table: unknown) => ({ where: (where: any) => ({ for: () => ({ limit: async () => [pendingStates.get(key)] }), limit: async (n: number) => { assert.equal(table, bridgeV2EventsTable); return filterRows(pendingEvents, where).slice(0, n); } }) }) }),
            update: () => ({ set: (values: any) => ({ where: async () => { if (failUpdate)
                        throw Error('state update failed'); pendingStates.set(key, { ...pendingStates.get(key), ...values }); } }) }),
        };
        const result = await callback(tx);
        beforeCommit?.();
        if (failCommit)
            throw Error('commit failed');
        events = pendingEvents;
        states = pendingStates;
        return result;
    },
};
mock.module('@workspace/db', { namedExports: { db: fakeDb, bridgeV2EventsTable, bridgeV2StreamStateTable } });
mock.module('@workspace/domain', { namedExports: { bridgeV2 } });
mock.module(new URL('../../data/providers/mt5Provider.js', import.meta.url).href, { namedExports: { mergeCandleFromMT5: () => { }, updateQuoteFromMT5: () => { }, recordMt5Tick: () => ({ firstSeenEaMs: 0, lastPostedEaMs: 0, reposts: 0, priorPostEaMs: null }) } });
mock.module(new URL('../../data/chart/formingBarComposer.js', import.meta.url).href, { namedExports: { foldFormingTick: () => { } } });
const { liveAccountEventBus: accountBus } = await import('../../live/liveAccountEventBus.js');
accountBus.onConnection(17, () => emitted.push(17));
accountBus.onConnection(18, () => emitted.push(18));
const connection = { id: 17, userId: 3, accountNumber: '12345678', serverName: 'Fixture server' };
mock.module(new URL('../connections.js', import.meta.url).href, { namedExports: { getUserConnection: async (user: number, id: number) => user === connection.userId && id === connection.id ? connection : null } });
mock.module(new URL('../bridgeV2StreamState.js', import.meta.url).href, { namedExports: { listBridgeV2StreamStates: async (user: number | null) => [...states.values()].filter(row => user == null || row.userId === user) } });
mock.module(new URL('../../bridgeV2/egress.js', import.meta.url).href, { namedExports: { loadBridgeV2ConfigForEa: async () => null, listBridgeV2CommandsForEa: async () => [] } });
const { nativeAccountBinding, projectNativeAccountReport, isExactNativeAccountReplay } = await import('../nativeAccountReport.js');
const { loadNativeAccountReport, loadBridgeV2AccountReport } = await import('../nativeAccountReportReader.js');
const { ingestBridgeV2Message } = await import('../../bridgeV2/ingest.js');
const { buildBridgeV2AdminStatus, buildBridgeV2UserStatus } = await import('../../bridgeV2/status.js');
const payload = (extra: Record<string, unknown> = {}) => ({ reportVersion: 1, source: 'NATIVE_ACCOUNT_INFO', accountBinding: nativeAccountBinding(connection.accountNumber, connection.serverName), producerInstanceId: 'b'.repeat(32), observedAtEpochMs: NOW - 50, clockBasis: 'TERMINAL_UTC_UNVERIFIED', captureDurationMs: 10, terminalConnected: true, currency: 'KWD', currencyDigits: 3, balance: '1000.125', equity: '1055.375', profit: '12.345', credit: '43.000', margin: '5.125', freeMargin: '1050.250', ...extra });
const message = (body: unknown = payload(), sequence = 1, extra: Record<string, unknown> = {}) => ({ protocolVersion: 2, messageType: 'ACCOUNT_SNAPSHOT', streamKey: 'ACCOUNT_NATIVE_V1', sequence, idempotencyKey: 'native-' + sequence, eaCreatedAtEpochMs: NOW - 40, eaVersion: '1.54', payload: body, ...extra });
const receipt = (extra: Record<string, unknown> = {}) => ({ userId: 3, bridgeConnectionId: 17, ...message(), accepted: true, duplicateDropped: false, sequenceVerdict: 'FIRST', serverReceivedAtEpochMs: NOW, ...extra });
const send = (raw: unknown = message(), bridgeConnectionId = 17, userId = 3, serverReceivedAtEpochMs = NOW) => ingestBridgeV2Message({ raw, bridgeConnectionId, userId, serverReceivedAtEpochMs });
beforeEach(() => { events = []; states = new Map(); emitted = []; queries = []; failCommit = false; failUpdate = false; failRejected = false; beforeCommit = null; nextId = 1; });
test('binding uses canonical integer login and exact UTF8 server bytes without raw identity in output', () => {
    assert.equal(nativeAccountBinding('00012345678', 'Fixture server'), '56819323d6fe9327ad47f0292b6b8818f23c996098c466391c9c3a1a146e0864');
    assert.notEqual(nativeAccountBinding('12345678', 'Fixture server '), nativeAccountBinding('12345678', 'Fixture server'));
    for (const login of ['0', '-1', '1e3', '1.0', ' 123'])
        assert.equal(nativeAccountBinding(login, 'Fixture server'), null);
    assert.equal(nativeAccountBinding('123', 'Fixture server\0'), null);
    const output = projectNativeAccountReport(connection, receipt(), NOW + 100);
    assert.equal(output.status, 'reported');
    assert.equal(output.currentVerified, false);
    assert.equal(output.amounts?.profit, '12.345');
    assert.equal(output.amounts?.credit, '43.000');
    assert.equal(output.observationAgeMs, 150);
    assert.ok(!JSON.stringify(output).includes('12345678'));
    assert.ok(!JSON.stringify(output).includes('accountBinding'));
});
for (const verdict of ['FIRST', 'IN_ORDER', 'GAP'])
    test(`${verdict} yields reported historical strings only`, () => {
        const output = projectNativeAccountReport(connection, receipt({ sequenceVerdict: verdict }), NOW + 86400000);
        assert.equal(output.status, 'reported');
        assert.equal(output.currentVerified, false);
        assert.equal(output.reason, 'CLOCK_AND_CONTINUITY_UNVERIFIED');
        assert.equal(output.amounts?.balance, '1000.125');
        assert.equal(output.observationAgeMs, 86400050);
    });
for (const extra of [{ userId: 9 }, { bridgeConnectionId: 18 }, { messageType: 'HEARTBEAT' }, { streamKey: 'other' }, { accepted: false }, { duplicateDropped: true }, { sequenceVerdict: 'RESET' }, { sequenceVerdict: 'DUPLICATE' }, { sequenceVerdict: 'invented' }, { sequence: -1 }, { sequence: NaN }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { eaCreatedAtEpochMs: NOW + 1 }, { eaCreatedAtEpochMs: NOW - 51 }, { eaCreatedAtEpochMs: null }, { serverReceivedAtEpochMs: NOW + 1 }, { serverReceivedAtEpochMs: NaN }, { protocolVersion: 1 }])
    test(`unsafe receipt ${JSON.stringify(extra)} withholds all amounts`, () => {
        const result = projectNativeAccountReport(connection, receipt(extra), NOW);
        assert.equal(result.status, 'unavailable');
        assert.equal(result.currentVerified, false);
        assert.equal(result.amounts, null);
    });
for (const extra of [{ accountBinding: '0'.repeat(64) }, { observedAtEpochMs: NOW + 1 }, { terminalConnected: false }, { reportVersion: 2 }, { profit: 12.345 }, { captureDurationMs: 5001 }, { margin: '-1.000' }, { currencyDigits: 2 }, { balance: '01.000' }, { currency: 'USD\n' }])
    test(`unsafe payload ${JSON.stringify(extra)} withholds all amounts`, () => assert.equal(projectNativeAccountReport(connection, receipt({ payload: payload(extra) }), NOW).amounts, null));
test('missing owner or changed account binding does not reuse another account report', () => {
    for (const conn of [null, { ...connection, userId: null }, { ...connection, accountNumber: '99' }, { ...connection, serverName: 'Different' }])
        assert.equal(projectNativeAccountReport(conn, receipt(), NOW).amounts, null);
});
test('reader is bounded to owner+exact connection, all attempts and receipt ID order', async () => {
    await send();
    events.push({ ...receipt({ userId: 9 }), id: 99 });
    events.push({ ...receipt({ bridgeConnectionId: 18 }), id: 100 });
    const report = await loadNativeAccountReport(connection, () => NOW + 100);
    assert.equal(report.status, 'reported');
    const query = queries.at(-1);
    assert.deepEqual(query.params, [3, 17, 'ACCOUNT_SNAPSHOT']);
    assert.ok(!query.sql.includes('accepted'));
    assert.ok(!query.sql.includes('stream_key'));
});
test('valid native capture commits before the existing connection advisory hint', async () => {
    beforeCommit = () => assert.deepEqual(emitted, []);
    const result = await send();
    assert.equal(result.accepted, true);
    assert.equal(result.idempotencyKey, 'native-1');
    assert.equal(result.streamKey, 'ACCOUNT_NATIVE_V1');
    assert.equal(result.sequence, 1);
    assert.deepEqual(emitted, [17]);
    assert.deepEqual((await loadNativeAccountReport(connection, () => NOW)).amounts, { balance: '1000.125', equity: '1055.375', profit: '12.345', credit: '43.000', margin: '5.125', freeMargin: '1050.250' });
});
for (const kind of ['malformed', 'wrong stream', 'future capture', 'sequence duplicate', 'RESET', 'conflicting idempotency key'])
    test(`new ${kind} cannot fall back to older reported amounts`, async () => {
        await send();
        let next: any = message(payload(), 2);
        if (kind === 'malformed')
            next.payload.profit = 1;
        if (kind === 'wrong stream')
            next.streamKey = 'WRONG';
        if (kind === 'future capture')
            next.payload.observedAtEpochMs = NOW + 5;
        if (kind === 'sequence duplicate')
            next = message(payload(), 1, { idempotencyKey: 'another-key' });
        if (kind === 'RESET')
            next = message(payload(), 0, { idempotencyKey: 'reset-key' });
        if (kind === 'conflicting idempotency key')
            next = message(payload({ profit: '99.000' }), 1);
        await send(next);
        assert.equal((await loadNativeAccountReport(connection, () => NOW + 10)).amounts, null);
        assert.deepEqual(emitted, [17, 17]);
    });
test('exact replay acknowledges correlated immutable receipt without extra trace, hint or renewed age', async () => {
    const raw = message();
    await send(raw);
    const before = await loadNativeAccountReport(connection, () => NOW + 1000);
    const result = await send(raw, 17, 3, NOW + 500);
    assert.equal(result.accepted, false);
    assert.equal(result.outcome, 'DUPLICATE');
    assert.equal(result.exactReplay, true);
    assert.equal(result.idempotencyKey, raw.idempotencyKey);
    assert.equal(result.sequence, raw.sequence);
    assert.equal(result.streamKey, raw.streamKey);
    assert.equal(events.length, 1);
    assert.deepEqual(emitted, [17]);
    assert.deepEqual(await loadNativeAccountReport(connection, () => NOW + 1000), before);
});
test('same key on another connection is a rejection there, not acknowledgement or an update to original scope', async () => {
    await send();
    const result = await send(message(), 18);
    assert.equal(result.exactReplay, false);
    assert.equal(result.duplicateReason, 'IDEMPOTENCY_CONFLICT');
    assert.deepEqual(emitted, [17, 18]);
    assert.equal((await loadNativeAccountReport({ ...connection, id: 18 }, () => NOW)).amounts, null);
    assert.equal((await loadNativeAccountReport(connection, () => NOW)).status, 'reported');
});
for (const field of ['profit', 'credit', 'producerInstanceId', 'currency'] as const)
    test(`exact replay rejects changed payload ${field}`, () => {
        const old = receipt();
        const changed = field === 'producerInstanceId' ? 'c'.repeat(32) : field === 'currency' ? 'USD' : '1.000';
        assert.equal(isExactNativeAccountReplay(old, receipt({ payload: payload({ [field]: changed }) })), false);
    });
test('JSONB property order has no effect on exact replay comparison', () => {
    const body = Object.fromEntries(Object.entries(payload()).reverse());
    assert.equal(isExactNativeAccountReplay(receipt({ payload: body }), receipt()), true);
});
for (const kind of ['commit', 'update', 'rejection'])
    test(`failed ${kind} persistence emits no hint`, async () => {
        if (kind === 'commit')
            failCommit = true;
        if (kind === 'update')
            failUpdate = true;
        if (kind === 'rejection')
            failRejected = true;
        if (kind === 'rejection')
            await send(message(payload({ profit: 1 })));
        else
            await assert.rejects(() => send(), /failed/);
        assert.deepEqual(emitted, []);
        assert.equal(events.length, 0);
    });
test('latest legacy payload remains explicitly unverified; numeric compatibility never borrows old native values', async () => {
    await send();
    await send(message({ balance: 1000, equity: 1100, margin: 10, freeMargin: 1090, currency: 'USD' }, 2, { streamKey: 'legacy' }));
    const report = await loadBridgeV2AccountReport(connection, () => NOW);
    assert.equal(report.nativeAccountReport.status, 'unavailable');
    assert.equal(report.accountMoneyReason, 'LEGACY_ACCOUNT_REPORT_UNVERIFIED');
    assert.equal(report.accountAmountsCurrentVerified, false);
    assert.equal(report.accountBalance, 1000);
});
test('admin native status preserves strings, no numeric fallback, capture time not mutable stream time', async () => {
    await send();
    let result = (await buildBridgeV2AdminStatus(3))[0]!;
    assert.equal(result.accountBalance, null);
    assert.equal(result.accountEquity, null);
    assert.equal(result.nativeAccountReport?.amounts?.profit, '12.345');
    assert.equal(result.accountAmountsCurrentVerified, false);
    assert.equal(result.lastAccountSnapshotAt, new Date(NOW - 50).toISOString());
    await send(message(payload(), 1, { idempotencyKey: 'sequence-repeat' }));
    result = (await buildBridgeV2AdminStatus(3))[0]!;
    assert.equal(result.lastAccountSnapshotAt, null);
    assert.equal(result.nativeAccountReport?.amounts, null);
});
test('redacted user status refuses unrelated newest account when multiple connections exist', async () => {
    await send();
    assert.equal((await buildBridgeV2UserStatus(3)).lastAccountAt, new Date(NOW - 50).toISOString());
    await send(message(payload(), 1, { idempotencyKey: 'other-connection' }), 18);
    assert.equal((await buildBridgeV2UserStatus(3)).lastAccountAt, null);
});
test('very old native creation age stays historical without overflowing int4 latency storage', async () => {
    const raw = message(payload({ observedAtEpochMs: NOW - 365 * 86400000 }), 1, { eaCreatedAtEpochMs: NOW - 365 * 86400000 });
    await send(raw);
    assert.equal(events[0].transportLatencyMs, null);
    assert.equal((await loadNativeAccountReport(connection, () => NOW)).currentVerified, false);
    assert.equal((await loadNativeAccountReport(connection, () => NOW)).status, 'reported');
});
test('actual extracted EA cross-language fixture passes validator, ingest, binding and exact decimal reader', async () => {
    const raw = JSON.parse(readFileSync(new URL('./fixtures/native-account-v154.json', import.meta.url), 'utf8'));
    const at = raw.eaCreatedAtEpochMs;
    assert.equal(bridgeV2.validateBridgeV2Message(raw).ok, true);
    const result = await send(raw, 17, 3, at + 10);
    assert.equal(result.accepted, true);
    const report = await loadNativeAccountReport(connection, () => at + 20);
    assert.equal(report.status, 'reported');
    assert.equal(report.amounts?.profit, '12.345');
    assert.equal(report.amounts?.equity, '1055.375');
    assert.equal(report.currencyDigits, 3);
    assert.equal(report.currentVerified, false);
});
test('read clock sampled after receipt query, so arrivals during awaited read are not future reports', async () => {
    await send();
    let calls = 0;
    const now = () => { assert.ok(queries.length > 0); calls++; return NOW + 1; };
    assert.equal((await loadNativeAccountReport(connection, now)).status, 'reported');
    assert.equal(calls, 1);
    queries = [];
    assert.equal((await loadBridgeV2AccountReport(connection, now)).nativeAccountReport.status, 'reported');
    assert.equal(calls, 2);
});
test('native trace and acknowledgement never claim transport LIVE from unverified terminal clock', async () => {
    const result = await send();
    assert.equal(result.freshnessVerdict, null);
    assert.equal(events[0].freshnessVerdict, null);
});
for (const [label, extra] of Object.entries({ futureCreation: { eaCreatedAtEpochMs: NOW + 1 }, creationBeforeCapture: { eaCreatedAtEpochMs: NOW - 100 }, unsafeSequence: { sequence: Number.MAX_SAFE_INTEGER + 1 } }))
    test(`native ${label} rejected before advancing stream`, async () => {
        const result = await send(message(payload(), 1, extra));
        assert.equal(result.accepted, false);
        assert.equal(states.size, 0);
        assert.equal(events.length, 1);
        assert.deepEqual(emitted, [17]);
    });
test('throwing advisory listener cannot turn a committed native report into failed acknowledgement', async () => {
    const broken = () => { throw Error('closed listener'); };
    accountBus.onConnection(17, broken);
    try {
        const result = await send();
        assert.equal(result.accepted, true);
        assert.equal(events.length, 1);
        assert.deepEqual(emitted, [17]);
    }
    finally {
        accountBus.offConnection(17, broken);
    }
});
test('native sequence int4 gap bound rejects overflow, preserves exact maximum and generic message contract', async () => {
    assert.equal(bridgeV2.validateBridgeV2Message(message(payload(), 2147483647)).ok, true);
    const excessive = message(payload(), 2147483648);
    assert.equal(bridgeV2.validateBridgeV2Message(excessive).ok, false);
    assert.equal((await send(excessive)).accepted, false);
    assert.equal(states.size, 0);
    assert.equal(events.length, 1);
    assert.equal(projectNativeAccountReport(connection, receipt({ sequence: 2147483648 }), NOW).amounts, null);
    assert.equal(isExactNativeAccountReplay(receipt({ sequence: 2147483648 }), receipt({ sequence: 2147483648 })), false);
    assert.equal(bridgeV2.validateBridgeV2Message(message({ balance: 1, equity: 1, margin: 0, freeMargin: 1, currency: 'USD' }, 2147483648, { streamKey: 'legacy' })).ok, true);
});
