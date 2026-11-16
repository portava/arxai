import unittest,time
from market_observation_contract import *
NOW=1793892000000

def snapshot():return dict(version=1,account=ACCOUNT,server=SERVER,readOnly=True,algoTradingAllowed=False,tester=False,terminalConnected=True,instanceId='real-instance',sequence=1,observedAtUtc=NOW//1000,serverNow=NOW//1000,lastQuoteServer=NOW//1000)
def quote():return dict(canonical='EURUSD',brokerSymbol='EURUSD',available=True,selected=True,synchronized=True,tickAvailable=True,tradeMode=4,bid=1.12,ask=1.1201,tickTimeServerMs=NOW-100,tickError=0,digits=5)
class ContractTests(unittest.TestCase):
 def test_genuine_bound_quote_preserves_bid_ask_account_and_tick_time(self):
  v=bound_quote(quote(),snapshot(),NOW);self.assertEqual(v['bid'],1.12);self.assertEqual(v['brokerTimeEpochMs'],NOW-100);self.assertEqual(v['account'],ACCOUNT)
 def test_missing_or_wrong_identity_and_any_execution_flag_refuse(self):
  for key,value in [('account','other'),('server','other'),('readOnly',False),('algoTradingAllowed',True),('tester',True),('terminalConnected',False)]:
   with self.assertRaises(ContractError):bound_quote(quote(),{**snapshot(),key:value},NOW)
 def test_old_ticks_do_not_get_fresh_observation_timestamp(self):
  with self.assertRaises(ContractError):bound_quote({**quote(),'tickTimeServerMs':NOW-5001},snapshot(),NOW)
  with self.assertRaises(ContractError):bound_quote({**quote(),'tickTimeServerMs':NOW+2000},snapshot(),NOW)
  with self.assertRaises(ContractError):bound_quote(quote(),{**snapshot(),'serverNow':NOW//1000+3600},NOW)
 def test_crossed_missing_unsynchronized_and_nontradable_quotes_rejected(self):
  for key,value in [('ask',1.11),('bid',0),('tickAvailable',False),('synchronized',False),('tradeMode',0),('tickTimeServerMs',0)]:
   with self.assertRaises(ContractError):bound_quote({**quote(),key:value},snapshot(),NOW)
 def test_no_dollar_basket_or_one_second_synthetic_substitution(self):
  with self.assertRaises(ContractError):bound_quote({**quote(),'canonical':'DXY','brokerSymbol':'USD Basket'},snapshot(),NOW)
  with self.assertRaises(ContractError):bound_quote({**quote(),'canonical':'V75','brokerSymbol':'Volatility 75 (1s) Index'},snapshot(),NOW)
 def test_candles_preserve_reported_price_basis_and_only_closed_bars(self):
  series=dict(canonical='CADJPY',brokerSymbol='CADJPY',timeframe='H1',closedOnly=True,chartPriceBasis='bid',error=0,copyCount=1,bars=[dict(openTimeServer=NOW//1000-3600,open=100,high=102,low=99,close=101,tickVolume=200,spreadPoints=12)])
  p=candle_payload(series,snapshot(),NOW);self.assertEqual(p['priceBasis'],'bid');self.assertEqual(p['bars'][0]['tickVolume'],200);self.assertEqual(p['bars'][0]['openTime'],NOW-3600000);self.assertEqual(p['sentAt'],NOW);self.assertEqual(p['brokerServerTime'],NOW)
  series['bars'][0]['openTimeServer']=NOW//1000
  with self.assertRaises(ContractError):candle_payload(series,snapshot(),NOW)
 def test_live_source_and_no_execution_methods_in_mql_collector(self):
  p=Path(__file__).resolve().parent.parent/'ArxMarketObservation.mqh'
  if not p.exists():p=Path('/Users/areyouok/arx-tier1-release/truth-fix-20261105/current/arxai/mt5-bridge/market/ArxMarketObservation.mqh')
  source=p.read_text()
  for token in ['OrderSend(', 'OrderSendAsync(', 'CTrade', 'PollAndExecute(', 'WebRequest(', 'AccountInfoDouble(']:self.assertNotIn(token,source)
  self.assertIn('SymbolInfoTick(name,tick)',source);self.assertIn('CopyRates(name,tf,1,wanted,bars)',source);self.assertIn('ArxMarketSeries(i,tf,2,complete)',source);self.assertIn('ArxMarketSeries(i,tf,200,complete)',source);self.assertIn('!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED)',source)
 def test_all_twenty_one_timeframes_and_actual_short_history(self):
  self.assertEqual(len(SUPPORTED_TIMEFRAMES),21)
  for tf in SUPPORTED_TIMEFRAMES-{'MN1'}:
   seconds=TIMEFRAME_SECONDS[tf];opening=NOW//1000-seconds
   series=dict(canonical='EURUSD',brokerSymbol='EURUSD',timeframe=tf,closedOnly=True,chartPriceBasis='bid',error=0,copyCount=1,historyDepthPartial=True,brokerHistoryBoundaryReached=True,bars=[dict(openTimeServer=opening,open=1.1,high=1.2,low=1,close=1.15,tickVolume=2,spreadPoints=1)])
   payload=candle_payload(series,snapshot(),NOW);self.assertEqual(len(payload['bars']),1);self.assertTrue(payload['brokerLimited']);self.assertEqual(payload['bars'][0]['closeTime'],NOW)
 def test_monthly_close_uses_next_calendar_month_including_leap_february(self):
  for start,end in [('2024-02-01T00:00:00+00:00','2024-03-01T00:00:00+00:00'),('2025-02-01T00:00:00+00:00','2025-03-01T00:00:00+00:00'),('2025-12-01T00:00:00+00:00','2026-01-01T00:00:00+00:00')]:
   a=int(datetime.fromisoformat(start).timestamp());b=int(datetime.fromisoformat(end).timestamp());self.assertEqual(candle_close_seconds(a,'MN1'),b)
  with self.assertRaises(ContractError):candle_close_seconds(int(datetime(2026,2,2,tzinfo=timezone.utc).timestamp()),'MN1')
 def test_indicator_read_only_and_bounded_work(self):
  p=Path(__file__).resolve().parent.parent/'ArxHistoryCollector.mq5'
  if not p.exists():p=Path('/Users/areyouok/arx-tier1-release/truth-fix-20261105/current/arxai/mt5-bridge/market/ArxHistoryCollector.mq5')
  source=p.read_text()
  for forbidden in ['OrderSend(', 'OrderSendAsync(', 'CTrade', 'WebRequest(', 'AccountInfoDouble(']:self.assertNotIn(forbidden,source)
  self.assertIn('if(!ArxMarketSafe()',source);self.assertIn('GetTickCount64()-began<150',source);self.assertIn('ExtraBackfillSnapshot()',source);self.assertIn('ArxExtraObserve();if(rates_total>0)',source);self.assertIn('SetIndexBuffer(0,extraPulse,INDICATOR_DATA)',source)
  import re
  self.assertEqual(set(re.findall(r'PERIOD_([A-Z0-9]+)',source))|{'M1','M5','H1'},SUPPORTED_TIMEFRAMES)
 def test_calendar_safety_heartbeat_follows_collection_and_precedes_dispatch(self):
  path=Path(__file__).resolve().parent.parent.parent/'calendar/ArxEconomicCalendar.mqh'
  source=path.read_text()
  self.assertLess(source.index('CalendarValueHistory('),source.index('ARX_CALENDAR_BEFORE_SEND();'))
  self.assertLess(source.index('ARX_CALENDAR_BEFORE_SEND();'),source.index('int code=ARX_CALENDAR_REQUEST('))
 def test_ea_timer_does_not_wait_on_any_candle_or_account_snapshot_producer(self):
  source=(Path(__file__).resolve().parent.parent/'runtime/ARX_ReadOnly_LocalTransport.mq5').read_text();body=source.split('void OnTimer()')[1].split('//+------------------------------------------------------------------+')[0]
  for forbidden in ['CopyRates(', 'CopyBuffer(', 'ArxObserveMarketData(', 'PushSnapshots(', 'PushCandleHistory(', 'PushLiveBrokerStream(', 'PollAndExecute(']:self.assertNotIn(forbidden,body)
  self.assertIn('SendHeartbeat()',body);self.assertIn('ArxPushEconomicCalendar(',body)
if __name__=='__main__':unittest.main()
