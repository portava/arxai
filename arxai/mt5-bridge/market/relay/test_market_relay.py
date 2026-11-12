import unittest
from market_relay import *
from test_market_observation_contract import snapshot,quote,NOW
class FakeResponse:
 status=200
 def __enter__(self):return self
 def __exit__(self,*args):pass
 def read(self,*args):return b'{"ok":true,"accepted":1}'
class FakeOpener:
 def __init__(self):self.requests=[]
 def open(self,request,timeout):self.requests.append(request);return FakeResponse()
class RelayTests(unittest.TestCase):
 def test_other_routes_and_non_tick_messages_denied_before_network(self):
  opener=FakeOpener()
  for route,payload in [('/api/mt5/commands',{}),('/api/mt5/heartbeat',{}),(TICK_ROUTE,{'messages':[{'messageType':'ORDER'}]})]:
   with self.assertRaises(ContractError):deliver(opener,'test-only',route,payload)
  self.assertEqual(opener.requests,[])
 def test_tick_message_keeps_real_observed_time_and_native_symbol(self):
  messages,rejected=tick_messages({**snapshot(),'quotes':[quote()]},NOW,'abc123',{})
  self.assertEqual(rejected,{});m=messages[0];self.assertEqual(m['eaCreatedAtEpochMs'],NOW);self.assertEqual(m['payload']['brokerTimeEpochMs'],NOW-100);self.assertEqual(m['payload']['brokerSymbol'],'EURUSD')
  opener=FakeOpener();status,result=deliver(opener,'test-only',TICK_ROUTE,{'messages':messages})
  self.assertEqual(status,200);self.assertEqual(opener.requests[0].full_url,'http://127.0.0.1:18765'+TICK_ROUTE)
 def test_old_tick_cannot_be_forwarded_by_new_snapshot(self):
  messages,rejected=tick_messages({**snapshot(),'quotes':[{**quote(),'tickTimeServerMs':NOW-6000}]},NOW,'abc123',{})
  self.assertEqual(messages,[]);self.assertIn('EURUSD',rejected)
 def test_fast_closed_bar_updates_preserve_tick_volume_and_source(self):
  series=dict(canonical='EURUSD',brokerSymbol='EURUSD',timeframe='M1',closedOnly=True,chartPriceBasis='bid',copyCount=2,error=0,bars=[dict(openTimeServer=NOW//1000-offset,open=1.1,high=1.2,low=1,close=1.15,tickVolume=42,spreadPoints=8) for offset in [120,60]])
  p=incremental_payload(series,snapshot(),NOW,NOW-120000)
  self.assertEqual(len(p['bars']),1);self.assertEqual(p['bars'][0]['openTime'],NOW-60000);self.assertEqual(p['bars'][0]['tickVolume'],42);self.assertEqual(p['priceBasis'],'bid');self.assertEqual(p['brokerSymbol'],'EURUSD')
  self.assertEqual(incremental_payload(series,snapshot(),NOW,NOW-60000)['bars'],[])
 def test_fast_lane_rejects_full_history_and_current_forming_bar(self):
  with self.assertRaises(ContractError):incremental_payload({'copyCount':200},snapshot(),NOW)
  series=dict(canonical='EURUSD',brokerSymbol='EURUSD',timeframe='M1',closedOnly=True,chartPriceBasis='bid',copyCount=1,error=0,bars=[dict(openTimeServer=NOW//1000,open=1.1,high=1.2,low=1,close=1.15,tickVolume=42,spreadPoints=8)])
  with self.assertRaises(ContractError):incremental_payload(series,snapshot(),NOW)
 def test_full_seed_rejects_hydrating_cache_but_accepts_proven_broker_limit(self):
  series=dict(canonical='EURUSD',brokerSymbol='EURUSD',timeframe='M1',closedOnly=True,chartPriceBasis='bid',copyCount=2,error=0,historyDepthPartial=True,brokerHistoryBoundaryReached=False,bars=[dict(openTimeServer=NOW//1000-offset,open=1.1,high=1.2,low=1,close=1.15,tickVolume=42,spreadPoints=8) for offset in [120,60]])
  with self.assertRaisesRegex(ContractError,'HISTORY_STILL_HYDRATING'):full_history_payload(series,snapshot(),NOW)
  self.assertEqual(len(incremental_payload(series,snapshot(),NOW)['bars']),2)
  series['brokerHistoryBoundaryReached']=True
  payload=full_history_payload(series,snapshot(),NOW)
  self.assertEqual(len(payload['bars']),2);self.assertTrue(payload['brokerLimited'])
 def test_full_seed_accepts_exact_native_target_without_claiming_broker_limit(self):
  series=dict(canonical='EURUSD',brokerSymbol='EURUSD',timeframe='M1',closedOnly=True,chartPriceBasis='bid',copyCount=200,error=0,bars=[dict(openTimeServer=NOW//1000-offset*60,open=1.1,high=1.2,low=1,close=1.15,tickVolume=42,spreadPoints=8) for offset in range(200,0,-1)])
  payload=full_history_payload(series,snapshot(),NOW)
  self.assertEqual(len(payload['bars']),200);self.assertFalse(payload['brokerLimited'])
 def test_unchanged_tip_renews_only_from_fresh_real_observation(self):
  series=dict(canonical='EURUSD',brokerSymbol='EURUSD',timeframe='M1',closedOnly=True,chartPriceBasis='bid',copyCount=2,error=0,bars=[dict(openTimeServer=NOW//1000-offset,open=1.1,high=1.2,low=1,close=1.15,tickVolume=42,spreadPoints=8) for offset in [120,60]])
  mark=(NOW-60000,100.)
  self.assertEqual(observed_tip_payload(series,snapshot(),NOW,mark,189.)['bars'],[])
  later={**snapshot(),'observedAtUtc':NOW//1000+91,'serverNow':NOW//1000+91,'lastQuoteServer':NOW//1000+91}
  refreshed=observed_tip_payload(series,later,NOW+91000,mark,191.)
  self.assertEqual(len(refreshed['bars']),2);self.assertEqual(refreshed['bars'][-1]['openTime'],NOW-60000);self.assertEqual(refreshed['bars'][-1]['tickVolume'],42);self.assertEqual(refreshed['sentAt'],NOW+91000)
  with self.assertRaisesRegex(ContractError,'OBSERVATION_STALE_OR_FUTURE'):observed_tip_payload(series,snapshot(),NOW+91000,mark,191.)
 def test_new_closed_bar_does_not_wait_for_reobservation_interval(self):
  series=dict(canonical='EURUSD',brokerSymbol='EURUSD',timeframe='M1',closedOnly=True,chartPriceBasis='bid',copyCount=2,error=0,bars=[dict(openTimeServer=NOW//1000-offset,open=1.1,high=1.2,low=1,close=1.15,tickVolume=42,spreadPoints=8) for offset in [120,60]])
  result=observed_tip_payload(series,snapshot(),NOW,(NOW-120000,100.),101.)
  self.assertEqual([bar['openTime'] for bar in result['bars']],[NOW-60000])
 def test_refresh_fairness_serves_unseen_then_new_then_oldest_attempt(self):
  payload={'bars':[{'openTime':200}]}
  rows=[('front|H1|front',payload,(200,0.),99.),('late|MN1|late',payload,None,100.),('new|M15|new',payload,(100,0.),101.),('old|H4|old',payload,(200,0.),1.)]
  self.assertEqual([row[0] for row in sorted(rows,key=fast_candidate_rank)],['late|MN1|late','new|M15|new','old|H4|old','front|H1|front'])
 def test_pending_bound_keeps_minute_lane_independent_and_rejects_duplicates(self):
  pending=set()
  for i in range(20):
   for tf in ['M1','H4']:
    key=f'S{i}|{tf}|N{i}'
    if fast_lane_has_room(key,pending):pending.add(key)
  self.assertEqual(len(pending),12);self.assertEqual(sum('|M1|' in key for key in pending),6)
  self.assertFalse(fast_lane_has_room(next(iter(pending)),pending))
if __name__=='__main__':unittest.main()
