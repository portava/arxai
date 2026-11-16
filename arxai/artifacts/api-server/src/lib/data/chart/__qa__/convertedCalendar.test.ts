import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCandles, rawTrailingIntervalGap, trailingIntervalGap } from '../candleNormalization.js';
import { convertedBrokerCandleTimeBasis } from '../../candleTimeBasisEvidence.js';

for (const offsetMs of [350, 2 * 3600000, -2 * 3600000]) {
  test(`converted MT5 monthly geometry preserves broker calendar (${offsetMs}ms)`, () => {
    const now = Date.UTC(2026, 10, 5);
    const raw = [8, 9].map(month => ({
      time: new Date(Date.UTC(2026, month, 1) - offsetMs).toISOString(),
      open: 100, high: 102, low: 99, close: 101,
      timeBasisEvidence: convertedBrokerCandleTimeBasis({ offsetMs, measuredAtMs: now }),
    }));
    const result = normalizeCandles(raw, {symbol:'EURUSD',displaySymbol:'EURUSD',timeframe:'MN1',source:'mt5_broker',now});
    assert.equal(result.anomalies.missingCandleCount, 0);
    assert.equal(result.candles.at(-1)?.closeTime, new Date(Date.UTC(2026,10,1)-offsetMs).toISOString());
    assert.equal(result.candles.at(-1)?.timeBasisEvidence?.kind, 'unavailable');
    assert.equal(rawTrailingIntervalGap(raw,'mt5_broker','MN1',now),1);
    assert.equal(trailingIntervalGap(result.candles,'MN1',now),1);
  });
}
