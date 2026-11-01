import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBridgeV2Message } from '../messageContract.js';
const now = 1793534400000;
const native = (extra: Record<string, unknown> = {}) => ({ reportVersion: 1, source: 'NATIVE_ACCOUNT_INFO', accountBinding: 'a'.repeat(64), producerInstanceId: 'b'.repeat(32), observedAtEpochMs: now, clockBasis: 'TERMINAL_UTC_UNVERIFIED', captureDurationMs: 12, terminalConnected: true, currency: 'USD', currencyDigits: 2, balance: '1000.00', equity: '1109.75', profit: '9.75', credit: '100.00', margin: '10.00', freeMargin: '1099.75', ...extra });
const message = (payload: unknown, extra: Record<string, unknown> = {}) => ({ protocolVersion: 2, messageType: 'ACCOUNT_SNAPSHOT', streamKey: 'ACCOUNT_NATIVE_V1', sequence: 1, idempotencyKey: 'native-fixture-key', eaCreatedAtEpochMs: now, eaVersion: '1.54', payload, ...extra });
const legacy = { balance: 1000, equity: 1110, margin: 10, freeMargin: 1100, currency: 'USD' };
test('all native account monetary strings survive unchanged, including credit and broker profit', () => {
    const result = validateBridgeV2Message(message(native()));
    assert.equal(result.ok, true);
    if (!result.ok)
        return;
    assert.deepEqual(result.payload, native());
});
for (const digits of [0, 3, 8, 16])
    test(`exact currency precision ${digits} is preserved without number conversion`, () => {
        const value = digits === 0 ? '123456789012345678901234567890' : '12345678901234567890.' + '1'.repeat(digits);
        const body = native({ currencyDigits: digits, ...Object.fromEntries(['balance', 'equity', 'profit', 'credit', 'margin', 'freeMargin'].map(k => [k, value])) });
        const result = validateBridgeV2Message(message(body));
        assert.equal(result.ok, true);
        if (result.ok)
            assert.equal((result.payload as any).balance, value);
    });
test('native report does not impose an equity formula or reject finite negative credit/free margin', () => {
    assert.equal(validateBridgeV2Message(message(native({ balance: '-1.00', equity: '5.00', profit: '-8.00', credit: '-2.00', freeMargin: '-99.00' }))).ok, true);
});
for (const version of [null, undefined, 0, 2, '1', {}, true])
    test(`declared unsupported version ${String(version)} never falls back to numeric legacy`, () => {
        assert.equal(validateBridgeV2Message(message({ ...legacy, reportVersion: version })).ok, false);
    });
test('only absent reportVersion preserves legacy numeric payload support', () => assert.equal(validateBridgeV2Message(message(legacy, { streamKey: 'default' })).ok, true));
for (const value of ['1', '1.0', '1.000', '+1.00', '1e2', 'NaN', 'Infinity', '-0.00', '-00.00', ' 1.00', '1.00 ', 1, null, '1'.repeat(49)])
    test(`invalid fixed decimal ${String(value)} fails native validation`, () => {
        assert.equal(validateBridgeV2Message(message(native({ profit: value }))).ok, false);
    });
for (const extra of [{ currencyDigits: 17 }, { currencyDigits: -1 }, { currencyDigits: 1.5 }, { currency: ' ' }, { currency: '123456789' }, { captureDurationMs: 5001 }, { captureDurationMs: -1 }, { captureDurationMs: 0.5 }, { observedAtEpochMs: Number.MAX_SAFE_INTEGER + 1 }, { accountBinding: 'A'.repeat(64) }, { producerInstanceId: 'b'.repeat(15) }, { producerInstanceId: 'B'.repeat(32) }, { margin: '-1.00' }, { terminalConnected: 'true' }, { clockBasis: 'UTC_VERIFIED' }, { source: 'DERIVED' }])
    test(`invalid native metadata ${JSON.stringify(extra)} fails`, () => assert.equal(validateBridgeV2Message(message(native(extra))).ok, false));
test('native version requires its single canonical stream', () => assert.equal(validateBridgeV2Message(message(native(), { streamKey: 'default' })).ok, false));
