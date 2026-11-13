"""Exercise real relay threads with isolated files and fully stubbed transport."""
from collections import Counter
from pathlib import Path
from unittest.mock import patch
import datetime,json,logging,os,signal,tempfile,threading,time,unittest,urllib.error
import market_relay as relay
from test_market_observation_contract import snapshot,quote

class HistoryLaneTests(unittest.TestCase):
 def test_repaired_backfill_gets_service_during_continuous_unresolved_seed_refreshes(self):
  with tempfile.TemporaryDirectory(prefix='arx-history-fairness-') as folder:
   service=Path(folder);spool=service/'spool';spool.mkdir();evidence=service/'accepted-evidence';evidence.mkdir()
   now=int(time.time());symbol='EURUSD';key=symbol+'|M1'
   observation={**snapshot(),'observedAtUtc':now,'serverNow':now,'lastQuoteServer':now}
   def series(symbol,count):
    return dict(canonical=symbol,brokerSymbol=symbol,timeframe='M1',closedOnly=True,chartPriceBasis='bid',copyCount=count,error=0,
     bars=[dict(openTimeServer=now-offset*60,open=1,high=2,low=.5,close=1.5,tickVolume=42,spreadPoints=1) for offset in range(count,0,-1)])
   accepted_at=datetime.datetime.now(datetime.timezone.utc).isoformat()
   (evidence/'EURUSD-M1.json').write_text(json.dumps({'acceptedAt':accepted_at,'http':200,
    'payload':{'symbol':symbol,'brokerSymbol':symbol,'timeframe':'M1','bars':[{'openTime':(now-i*60)*1000} for i in range(200,0,-1)]},
    'result':{'ok':True,'acceptedBars':200,'rejectedBars':0}}))
   target=spool/'backfill-extra-EURUSD-M1.json';cursor=now-60
   (spool/'backfill-request-EURUSD-M1.txt').write_text(str(cursor))
   broken={**series(symbol,0),'error':4401,'historyKind':'backfill','requestedHistoryBars':5000,'requestedEndServer':cursor,'serverFirstHistoryServer':1,'brokerHistoryBoundaryReached':False}
   target.write_text(json.dumps({**observation,'series':[broken]}))
   repaired={**series(symbol,5000),'historyKind':'backfill','requestedHistoryBars':5000,'requestedEndServer':cursor,'serverFirstHistoryServer':1,'brokerHistoryBoundaryReached':False}
   # All of these are valid native-shaped seed pages, but transport keeps
   # failing. Their depth therefore remains unresolved while files refresh.
   seeds=[(spool/('history-extra-'+s+'-M1.json'),series(s,200)) for s in list(relay.UNIVERSE) if s!=symbol]
   broken_read=threading.Event();repair_ready=threading.Event();accepted=threading.Event();finished=threading.Event()
   handlers={};guard=threading.Lock();active=0;peak=0;seed_attempts=0;seed_attempts_after_backfill=0;repair_at=None;backfill_at=None
   original_read=relay.calendar.read_regular
   def read_regular(path):
    value=original_read(path)
    if path==target and not repair_ready.is_set():broken_read.set()
    return value
   def stop():
    finished.set()
    if signal.SIGTERM in handlers:handlers[signal.SIGTERM](None,None)
   def fake_signal(kind,handler):handlers[kind]=handler
   def rewrite(path,payload):
    temporary=path.with_suffix('.fixture-tmp');temporary.write_text(json.dumps(payload));temporary.replace(path)
   def producer():
    nonlocal repair_at
    if not broken_read.wait(2):stop();return
    # Let the failed snapshot finish and acquire its recent last-attempt mark.
    time.sleep(.1)
    for path,row in seeds:rewrite(path,{**observation,'series':[row]})
    repair_at=time.monotonic();rewrite(target,{**observation,'series':[repaired]});repair_ready.set()
    while not finished.wait(.1):
     for path,row in seeds:
      if finished.is_set():break
      rewrite(path,{**observation,'series':[row]})
   def deliver(opener,token,route,payload):
    nonlocal active,peak,seed_attempts,seed_attempts_after_backfill,backfill_at
    self.assertEqual(route,relay.CANDLE_ROUTE)
    with guard:active+=1;peak=max(peak,active)
    try:
     time.sleep(.03)
     if payload.get('historyPage',{}).get('kind')=='backfill':
      self.assertEqual(payload['symbol'],symbol);self.assertEqual(len(payload['bars']),5000)
      self.assertEqual(payload['sentAt'],now*1000,'The relay must retain the original native observation time')
      backfill_at=time.monotonic();accepted.set()
      return 200,{'ok':True,'acceptedBars':5000,'rejectedBars':0}
     with guard:
      seed_attempts+=1
      if accepted.is_set():
       seed_attempts_after_backfill+=1
       if seed_attempts_after_backfill>=3:stop()
     return 503,{'ok':False}
    finally:
     with guard:active-=1
   class HealthResponse:
    def __enter__(self):return self
    def __exit__(self,*_):pass
    def read(self,*_):return json.dumps({'ok':True,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'uptimeSeconds':600}).encode()
   class LocalStubOpener:
    def open(self,*_,**__):return HealthResponse()
   def native(stop_event,*_):stop_event.wait()
   writer=threading.Thread(target=producer);timeout=threading.Timer(4,stop);timeout.start();writer.start()
   try:
    with patch.object(relay,'SERVICE',service),patch.object(relay,'SPOOL',spool),patch.object(relay.calendar,'load_token',return_value='offline-test-only'),patch.object(relay.calendar,'read_regular',side_effect=read_regular),patch.object(relay.signal,'signal',side_effect=fake_signal),patch.object(relay.urllib.request,'build_opener',return_value=LocalStubOpener()),patch.object(relay,'deliver',side_effect=deliver),patch.object(relay,'run_native_seam_lane',side_effect=native):
     relay.run()
   finally:
    timeout.cancel();stop();writer.join(timeout=2)
    logger=logging.getLogger('market_relay')
    for handler in list(logger.handlers):
     if getattr(handler,'baseFilename','')==str(service/'relay.log'):logger.removeHandler(handler);handler.close()
   self.assertTrue(broken_read.is_set());self.assertTrue(repair_ready.is_set())
   self.assertTrue(accepted.is_set(),'A repaired backfill must not wait behind continuously refreshed unresolved seeds')
   self.assertLess(backfill_at-repair_at,2,'Backfill must get a free worker promptly, not after the freshness window')
   self.assertGreaterEqual(seed_attempts_after_backfill,3,'Seed work must continue after backfill is admitted')
   self.assertEqual(peak,3,'Exercise the real unchanged three-worker bound')
   receipt=json.loads((evidence/'EURUSD-M1.json').read_text())
   self.assertEqual(receipt['result']['acceptedBars'],5000)
   self.assertEqual(receipt['payload']['sentAt'],now*1000)

 def test_slow_quote_does_not_block_history_and_transient_same_files_retry(self):
  with tempfile.TemporaryDirectory(prefix='arx-history-lane-') as folder:
   service=Path(folder);spool=service/'spool';spool.mkdir()
   now=int(time.time());observation={**snapshot(),'observedAtUtc':now,'serverNow':now,'lastQuoteServer':now}
   for i in range(903):
    path=spool/('history-extra-000old'+str(i)+'-M1.json')
    path.write_text('Old spool files must not consume a worker or be parsed.')
    os.utime(path,(now-121,now-121))
   symbols=['EURUSD','GBPUSD','USDJPY','AUDUSD','NZDUSD','USDCHF']
   for symbol in symbols:
    series=dict(canonical=symbol,brokerSymbol=symbol,timeframe='M1',closedOnly=True,chartPriceBasis='bid',copyCount=200,error=0,
     bars=[dict(openTimeServer=now-offset*60,open=1,high=2,low=.5,close=1.5,tickVolume=42,spreadPoints=1) for offset in range(200,0,-1)])
    (spool/('history-extra-'+symbol+'-M1.json')).write_text(json.dumps({**observation,'series':[series]}))
   # Touching an old observation cannot bypass the worker's actual header gate.
   (spool/'history-extra-RECENTMTIME-M1.json').write_text(json.dumps({**observation,'observedAtUtc':now-121,'series':[series]}))
   (spool/'quotes.json').write_text(json.dumps({**observation,'quotes':[{**quote(),'tickTimeServerMs':now*1000}]}))
   quote_started=threading.Event();release_quote=threading.Event();handlers={};counts=Counter();attempts={};accepted=set();active=0;peak=0;progress_while_quote_blocked=False;old_files_read=[]
   guard=threading.Lock()
   original_read=relay.calendar.read_regular
   def read_regular(path):
    if path.name.startswith('history-extra-000old'):old_files_read.append(path.name)
    return original_read(path)
   def stop():
    if signal.SIGTERM in handlers:handlers[signal.SIGTERM](None,None)
    release_quote.set()
   def fake_signal(kind,handler):handlers[kind]=handler
   def deliver(opener,token,route,payload):
    nonlocal active,peak,progress_while_quote_blocked
    if route==relay.TICK_ROUTE:
     quote_started.set();release_quote.wait(6);return 200,{'accepted':len(payload['messages'])}
    self.assertEqual(route,relay.CANDLE_ROUTE);self.assertTrue(quote_started.wait(2))
    symbol=payload['symbol']
    with guard:
     active+=1;peak=max(peak,active);counts[symbol]+=1;attempt=counts[symbol]
     attempts.setdefault(symbol,[]).append(time.monotonic())
    try:
     time.sleep(.02)
     if attempt==1 and symbol=='EURUSD':return 503,{'ok':False}
     if attempt==1 and symbol=='GBPUSD':raise urllib.error.URLError('offline fixture')
     with guard:
      accepted.add(symbol)
      if len(accepted)==len(symbols):
       progress_while_quote_blocked=not release_quote.is_set();stop()
     return 200,{'ok':True,'acceptedBars':len(payload['bars']),'rejectedBars':0}
    finally:
     with guard:active-=1
   class HealthResponse:
    def __enter__(self):return self
    def __exit__(self,*_):pass
    def read(self,*_):return json.dumps({'ok':True,'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'uptimeSeconds':600}).encode()
   class LocalStubOpener:
    def open(self,*_,**__):return HealthResponse()
   def native(stop_event,*_):stop_event.wait()
   timeout=threading.Timer(6,stop);timeout.start()
   try:
    with patch.object(relay,'SERVICE',service),patch.object(relay,'SPOOL',spool),patch.object(relay.calendar,'load_token',return_value='offline-test-only'),patch.object(relay.calendar,'read_regular',side_effect=read_regular),patch.object(relay.signal,'signal',side_effect=fake_signal),patch.object(relay.urllib.request,'build_opener',return_value=LocalStubOpener()),patch.object(relay,'deliver',side_effect=deliver),patch.object(relay,'run_native_seam_lane',side_effect=native):
     relay.run()
   finally:
    timeout.cancel();stop()
    logger=logging.getLogger('market_relay')
    for handler in list(logger.handlers):
     if getattr(handler,'baseFilename','')==str(service/'relay.log'):logger.removeHandler(handler);handler.close()
   self.assertTrue(progress_while_quote_blocked,'History dispatch must not wait for the stalled quote HTTP response')
   self.assertEqual(accepted,set(symbols));self.assertLessEqual(peak,3)
   state=json.loads((service/'relay-status.json').read_text())
   self.assertEqual(state['historyDispatchSkippedOldFiles'],903)
   self.assertEqual(state['historyDispatchRecentFiles'],7)
   self.assertEqual(old_files_read,[])
   self.assertEqual(state['lastHistoryError']['type'],'URLError')
   self.assertEqual(counts,Counter({'EURUSD':2,'GBPUSD':2,'USDJPY':1,'AUDUSD':1,'NZDUSD':1,'USDCHF':1}))
   for symbol in ['EURUSD','GBPUSD']:self.assertGreaterEqual(attempts[symbol][1]-attempts[symbol][0],relay.HISTORY_RETRY_SECONDS)
