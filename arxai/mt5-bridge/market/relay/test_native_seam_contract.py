import copy,json,threading,tempfile,unittest
from datetime import datetime,timezone
from pathlib import Path
from unittest.mock import patch
from native_seam_contract import *
from native_seam_lane import run_native_seam_lane,native_pair_changed
from market_observation_contract import candle_payload
from test_market_observation_contract import snapshot,NOW
from market_relay import deliver
from test_market_relay import FakeOpener

def bar(opened):return dict(openTimeEpochMs=opened,open=1.1,high=1.2,low=1,close=1.15)
def series():
 observation=dict(symbol='EURUSD',brokerSymbol='EURUSD',timeframe='M1',collectedAtEpochMs=NOW,brokerServerTimeEpochMs=NOW,brokerUtcOffsetMs=0,lastClosed=bar(NOW-60000),forming=bar(NOW))
 return dict(canonical='EURUSD',brokerSymbol='EURUSD',timeframe='M1',closedOnly=True,chartPriceBasis='bid',copyCount=2,error=0,bars=[dict(openTimeServer=NOW//1000-offset,open=1.1,high=1.2,low=1,close=1.15,tickVolume=42,spreadPoints=8) for offset in [120,60]],nativeSeam=dict(available=True,copyCount=2,error=0,synchronized=True,observation=observation))
def receipt(payload):
 return dict(ok=True,received=len(payload['observations']),accepted=len(payload['observations']),rejected=0,results=[dict(index=i,symbol=o['symbol'],brokerSymbol=o['brokerSymbol'],timeframe=o['timeframe'],accepted=True,reason='NATIVE_PAIR_OBSERVED') for i,o in enumerate(payload['observations'])])
class NativeSeamTests(unittest.TestCase):
 def test_native_pair_is_separate_and_closed_payload_is_unchanged(self):
  row=series();original=copy.deepcopy(row);closed=candle_payload(row,snapshot(),NOW)
  observation=native_seam_observation(row,snapshot(),NOW)
  self.assertEqual(observation['forming']['openTimeEpochMs'],NOW)
  self.assertEqual([b['openTime'] for b in closed['bars']],[NOW-120000,NOW-60000]);self.assertNotIn('nativeSeam',closed)
  observation['forming']['close']=99;self.assertEqual(row,original)
 def test_wrong_account_readonly_and_trading_guards_refuse(self):
  for key,value in [('account','other'),('server','other'),('readOnly',False),('algoTradingAllowed',True),('terminalConnected',False)]:
   with self.assertRaises(ContractError):native_seam_observation(series(),{**snapshot(),key:value},NOW)
 def test_native_identity_writer_spoof_and_missing_copy_are_rejected(self):
  for field,value in [('symbol','CADJPY'),('brokerSymbol','EURUSD.fake'),('timeframe','H4'),('bridgeConnectionId',15)]:
   row=series();row['nativeSeam']['observation'][field]=value
   with self.assertRaises(ContractError):native_seam_observation(row,snapshot(),NOW)
  for field,value in [('copyCount',1),('synchronized',False),('available',False),('error',4401),('error',False),('copyCount',2.0)]:
   row=series();row['nativeSeam'][field]=value
   with self.assertRaises(ContractError):native_seam_observation(row,snapshot(),NOW)
 def test_fresh_envelope_does_not_restamp_old_native_observation(self):
  row=series();row['nativeSeam']['observation']['collectedAtEpochMs']=NOW-120001
  with self.assertRaisesRegex(ContractError,'STALE_OR_FUTURE'):native_seam_observation(row,snapshot(),NOW)
  row=series();row['nativeSeam']['observation']['collectedAtEpochMs']=NOW+1001
  with self.assertRaises(ContractError):native_seam_observation(row,snapshot(),NOW)
 def test_raw_second_jitter_is_preserved_and_not_rounded(self):
  row=series();o=row['nativeSeam']['observation'];o['brokerServerTimeEpochMs']+=1000;o['brokerUtcOffsetMs']=1000
  self.assertEqual(native_seam_observation(row,snapshot(),NOW)['brokerUtcOffsetMs'],1000)
  o['brokerUtcOffsetMs']=0
  with self.assertRaisesRegex(ContractError,'CLOCK_UNVERIFIED'):native_seam_observation(row,snapshot(),NOW)
 def test_invalid_prices_order_and_closed_forming_bar_refuse(self):
  changes=[('close',float('nan')),('low',1.3),('open',0),('openTimeEpochMs',NOW-60000)]
  for field,value in changes:
   row=series();row['nativeSeam']['observation']['forming'][field]=value
   with self.assertRaises(ContractError):native_seam_observation(row,snapshot(),NOW)
 def test_monthly_leap_boundary_uses_real_calendar_not31days(self):
  ts=lambda y,m,d:int(datetime(y,m,d,tzinfo=timezone.utc).timestamp()*1000)
  now=ts(2024,2,29);snap={**snapshot(),'observedAtUtc':now//1000,'serverNow':now//1000,'lastQuoteServer':now//1000};row=series();row['timeframe']='MN1';o=row['nativeSeam']['observation'];o.update(timeframe='MN1',collectedAtEpochMs=now,brokerServerTimeEpochMs=now,lastClosed=bar(ts(2024,1,1)),forming=bar(ts(2024,2,1)))
  self.assertEqual(native_seam_observation(row,snap,now)['forming']['openTimeEpochMs'],ts(2024,2,1))
  o['collectedAtEpochMs']=o['brokerServerTimeEpochMs']=ts(2024,3,1);snap.update(observedAtUtc=ts(2024,3,1)//1000,serverNow=ts(2024,3,1)//1000,lastQuoteServer=ts(2024,3,1)//1000)
  with self.assertRaisesRegex(ContractError,'NOT_CURRENT_PAIR'):native_seam_observation(row,snap,ts(2024,3,1))
 def test_session_gap_is_preserved_not_filled_or_relabelled(self):
  row=series();row['nativeSeam']['observation']['lastClosed']['openTimeEpochMs']=NOW-3*86400000
  self.assertEqual(native_seam_observation(row,snapshot(),NOW)['lastClosed']['openTimeEpochMs'],NOW-3*86400000)
 def test_receipts_bind_each_result_to_exact_input_not_ok_only(self):
  payload,_=native_seam_batch({**snapshot(),'series':[series()]},NOW);result=receipt(payload);self.assertTrue(bound_native_results(payload,200,result)[0]['accepted'])
  for change in ['identity','count','index','missing']:
   bad=copy.deepcopy(result)
   if change=='identity':bad['results'][0]['brokerSymbol']='other'
   elif change=='count':bad['accepted']=0
   elif change=='index':bad['results'][0]['index']=2
   else:bad['results']=[]
   with self.assertRaises(ContractError):bound_native_results(payload,200,bad)
 def test_native_endpoint_shape_cannot_carry_commands_or_account_routes(self):
  opener=FakeOpener();payload,_=native_seam_batch({**snapshot(),'series':[series()]},NOW)
  for route,body in [('/api/mt5/commands',payload),(NATIVE_SEAM_ROUTE,{'commands':[]}),(NATIVE_SEAM_ROUTE,{'observations':payload['observations']*51})]:
   with self.assertRaises(ContractError):deliver(opener,'test-only',route,body)
  self.assertEqual(opener.requests,[])
 def test_observed_rollover_bypasses_cadence_without_clock_inference(self):
  payload={'observations':[series()['nativeSeam']['observation']]};before=copy.deepcopy(payload)
  heads={('EURUSD','M1'):('EURUSD',NOW)}
  self.assertFalse(native_pair_changed(payload,heads));self.assertFalse(native_pair_changed(payload,{}))
  payload['observations'][0]['collectedAtEpochMs']+=2000
  self.assertFalse(native_pair_changed(payload,heads))
  payload['observations'][0]['forming']['openTimeEpochMs']+=60000
  self.assertTrue(native_pair_changed(payload,heads))
  self.assertEqual(heads,{('EURUSD','M1'):('EURUSD',NOW)})
  self.assertEqual(before['observations'][0]['forming']['openTimeEpochMs'],NOW)
 def test_observed_native_identity_change_bypasses_same_period_cadence(self):
  payload={'observations':[series()['nativeSeam']['observation']]}
  self.assertTrue(native_pair_changed(payload,{('EURUSD','M1'):('EURUSD.old',NOW)}))
 def test_lane_delivers_new_observed_forming_pair_before20second_resend(self):
  with tempfile.TemporaryDirectory() as folder:
   service=Path(folder);spool=service/'spool';spool.mkdir();path=spool/'fast-m1.json';first={**snapshot(),'series':[series()]};path.write_text(json.dumps(first));stop=threading.Event();sent=[];clock=[NOW]
   def send(payload):
    sent.append(copy.deepcopy(payload))
    if len(sent)==1:
     newer=copy.deepcopy(first);newer.update(sequence=first['sequence']+1,observedAtUtc=NOW//1000+60,serverNow=NOW//1000+60,lastQuoteServer=NOW//1000+60);o=newer['series'][0]['nativeSeam']['observation'];o.update(collectedAtEpochMs=NOW+60000,brokerServerTimeEpochMs=NOW+60000,lastClosed=bar(NOW),forming=bar(NOW+60000));clock[0]=NOW+60000;path.write_text(json.dumps(newer))
    else:stop.set()
    return 200,receipt(payload)
   timer=threading.Timer(3,stop.set);timer.start()
   try:
    with patch('native_seam_lane.time.time',side_effect=lambda:clock[0]/1000):run_native_seam_lane(stop,service,spool,{},threading.Lock(),send)
   finally:timer.cancel()
   self.assertEqual(len(sent),2);self.assertEqual(sent[1]['observations'][0]['forming']['openTimeEpochMs'],NOW+60000)
 def test_diagnostic_spool_is_never_selected_for_forwarding(self):
  with tempfile.TemporaryDirectory() as folder:
   service=Path(folder);spool=service/'spool';spool.mkdir();(spool/'diagnostic-xau-M1.json').write_text(json.dumps({**snapshot(),'series':[series()]}));stop=threading.Event();sent=[]
   timer=threading.Timer(.05,stop.set);timer.start()
   try:
    with patch('native_seam_lane.time.time',return_value=NOW/1000):run_native_seam_lane(stop,service,spool,{},threading.Lock(),lambda payload:sent.append(payload))
   finally:timer.cancel()
   self.assertEqual(sent,[]);self.assertEqual(list(spool.glob('history-extra-*.json')),[])
 def test_bounded_lane_preserves_actual_payload_and_native_receipt(self):
  with tempfile.TemporaryDirectory() as folder:
   service=Path(folder);spool=service/'spool';spool.mkdir();source={**snapshot(),'series':[series()]};(spool/'fast-m1.json').write_text(json.dumps(source));stop=threading.Event();state={};lock=threading.Lock();sent=[]
   def send(payload):sent.append(copy.deepcopy(payload));stop.set();return 200,receipt(payload)
   with patch('native_seam_lane.time.time',return_value=NOW/1000):run_native_seam_lane(stop,service,spool,state,lock,send)
   self.assertEqual(len(sent),1);self.assertTrue(state['nativeSeamSeries']['EURUSD|M1']['accepted']);self.assertTrue(state['nativeSeamSeries']['EURUSD|M1']['seamMeasurementNotAsserted'])
   proof=json.loads((service/'native-seam-evidence/fast-m1.json').read_text());self.assertEqual(proof['payload'],sent[0]);self.assertEqual(proof['sourceSnapshot'],source)
if __name__=='__main__':unittest.main()
