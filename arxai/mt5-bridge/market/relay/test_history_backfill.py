import unittest,tempfile
from pathlib import Path
from market_observation_contract import candle_payload,ContractError
from market_relay import persist_backfill_request,full_history_payload
from test_market_observation_contract import snapshot,NOW

class BackfillTests(unittest.TestCase):
 def series(self,count=5000):
  return dict(canonical='EURUSD',brokerSymbol='EURUSD',timeframe='M1',closedOnly=True,chartPriceBasis='bid',error=0,copyCount=count,
   historyKind='backfill',requestedHistoryBars=5000,requestedEndServer=NOW//1000-60,serverFirstHistoryServer=1,brokerHistoryBoundaryReached=False,
   bars=[dict(openTimeServer=NOW//1000-(count-i)*60,open=1,high=2,low=.5,close=1.5,tickVolume=2,spreadPoints=1) for i in range(count)])
 def test_real_bounded_page_and_native_clock_evidence(self):
  p=full_history_payload(self.series(),snapshot(),NOW)
  self.assertEqual(len(p['bars']),5000);self.assertEqual(p['clockBasis'],'broker_server')
  self.assertEqual(p['historyPage']['requestedEndRawMs'],NOW-60000)
 def test_partial_native_hydration_is_not_a_boundary(self):
  with self.assertRaises(ContractError):full_history_payload(self.series(12),snapshot(),NOW)
 def test_retry_cannot_reuse_stale_or_wrong_identity_observation(self):
  source=snapshot();series=self.series()
  original=full_history_payload(series,source,NOW)
  with self.assertRaisesRegex(ContractError,'OBSERVATION_STALE_OR_FUTURE'):
   full_history_payload(series,source,NOW+120001)
  with self.assertRaisesRegex(ContractError,'IDENTITY_OR_READ_ONLY_GUARD_FAILED'):
   full_history_payload(series,{**source,'account':'different'},NOW)
  self.assertEqual(full_history_payload(series,source,NOW)['sentAt'],original['sentAt'])
 def test_false_boundary_and_wrong_cursor_rejected(self):
  for change in [dict(brokerHistoryBoundaryReached=True),dict(requestedEndServer=1)]:
   with self.assertRaises(ContractError):candle_payload({**self.series(),**change},snapshot(),NOW)
 def test_only_matching_server_hint_writes_cursor(self):
  payload=candle_payload(self.series(),snapshot(),NOW)
  hint=dict(symbol='EURUSD',brokerSymbol='EURUSD',timeframe='M1',historyIdentity='a'*64,suggestedEndTimeRaw='2020-01-01T00:00:00.000Z',status='BUILDING')
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);persist_backfill_request(root,payload,{'nextBackfillHints':[{**hint,'symbol':'XAUUSD'}]})
   self.assertEqual(list(root.iterdir()),[])
   persist_backfill_request(root,payload,{'nextBackfillHints':[hint]})
   self.assertEqual((root/'backfill-request-EURUSD-M1.txt').read_text(),'1577836800')
   persist_backfill_request(root,payload,{'nextBackfillHints':[{**hint,'suggestedEndTimeRaw':None,'status':'COMPLETE'}]})
   self.assertEqual((root/'backfill-request-EURUSD-M1.txt').read_text(),'0')
