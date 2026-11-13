"""Allowlisted read-only quote/candle transport. No commands or trading routes."""
from pathlib import Path
import math,concurrent.futures,fcntl,importlib.util,json,logging,os,signal,threading,time,uuid,urllib.request,urllib.error
from logging.handlers import RotatingFileHandler
from market_observation_contract import *
from market_history_schedule import *
from native_seam_contract import NATIVE_SEAM_ROUTE,validate_native_envelope
from native_seam_lane import run_native_seam_lane
SERVICE=Path(__file__).resolve().parent
import market_transport as calendar
SPOOL=calendar.TERMINAL/'MQL5/Files/ARX_ReadOnly_MarketData'
TICK_ROUTE='/api/bridge/v2/ingest';CANDLE_ROUTE='/api/mt5/candles/ingest'

def deliver(opener,token,route,payload):
    if route not in (TICK_ROUTE,CANDLE_ROUTE,NATIVE_SEAM_ROUTE):raise ContractError('READ_ONLY_ROUTE_DENIED')
    if route==TICK_ROUTE and (set(payload)!={'messages'} or not 1<=len(payload['messages'])<=43 or any(m.get('messageType')!='TICK' for m in payload['messages'])):raise ContractError('TICK_ONLY_ENVELOPE_REQUIRED')
    if route==NATIVE_SEAM_ROUTE:validate_native_envelope(payload)
    body=json.dumps(payload,separators=(',',':')).encode()
    if len(body)>2*1024*1024:raise ContractError('BODY_TOO_LARGE')
    req=urllib.request.Request(calendar.BASE_URL+route,data=body,method='POST',headers={'X-MT5-Bridge-Token':token,'Content-Type':'application/json','Accept':'application/json'})
    try:
        with opener.open(req,timeout=20 if route==CANDLE_ROUTE else 6) as response:
            result=json.loads(response.read(1024*1024));return response.status,result
    except urllib.error.HTTPError as exc:
        # Never log arbitrary server response/header data, which may contain credentials.
        return exc.code,{'ok':False,'error':'HTTP_ERROR'}

def tick_messages(observation,now_ms,relay_id,sequences):
    valid=[];rejected={}
    for row in observation.get('quotes',[]):
        try:q=bound_quote(row,observation,now_ms)
        except ContractError as exc:rejected[row.get('canonical','unknown')]=str(exc);continue
        symbol=q['symbol'];sequence=sequences.get(symbol,0)+1;sequences[symbol]=sequence
        valid.append({'protocolVersion':2,'messageType':'TICK','streamKey':f'readonly-market:{relay_id}:{symbol}',
          'sequence':sequence,'idempotencyKey':f'{relay_id}:{symbol}:{sequence}',
          'eaCreatedAtEpochMs':q['eaObservedAtEpochMs'],'eaVersion':'1.55-readonly-market-observer',
          'payload':{key:q[key] for key in ('symbol','brokerSymbol','bid','ask','brokerTimeEpochMs')}})
    return valid,rejected

def incremental_payload(series,observation,now_ms,last_open_ms=None):
    if series.get('copyCount',0)>2:raise ContractError('FAST_CLOSED_BAR_LIMIT')
    payload=candle_payload(series,observation,now_ms)
    if last_open_ms is not None:payload['bars']=[bar for bar in payload['bars'] if bar['openTime']>last_open_ms]
    return payload

TIP_REOBSERVE_SECONDS=90
FAST_LANE_PENDING_LIMIT=6

def observed_tip_payload(series,observation,now_ms,mark,monotonic_now):
    # mark=(last accepted native open time, monotonic time of actual receipt).
    # Re-observation uses a newly collected snapshot; no bar or snapshot time is
    # manufactured. An unchanged closed tip proves the native reader is alive.
    validate_header(observation,now_ms,max_age_ms=15000)
    latest_only=mark[0] if mark is not None and monotonic_now-mark[1]<TIP_REOBSERVE_SECONDS else None
    return incremental_payload(series,observation,now_ms,latest_only)

def fast_lane_has_room(key,inflight):
    minute=key.split('|')[1]=='M1'
    return key not in inflight and sum((item.split('|')[1]=='M1')==minute for item in inflight)<FAST_LANE_PENDING_LIMIT

def fast_candidate_rank(candidate):
    key,payload,mark,attempt=candidate
    unserved=mark is None
    new_tip=unserved or payload['bars'][-1]['openTime']>mark[0]
    return (0 if unserved else 1 if new_tip else 2,attempt,key)

def full_history_payload(series,observation,now_ms):
    payload=candle_payload(series,observation,now_ms)
    # A short local cache is still hydrating. Its oldest aggregated weekly or
    # monthly bar can change as earlier underlying history arrives. Only publish
    # the full requested target or a proven broker history boundary as a seed.
    wanted=payload.get('historyPage',{}).get('requestedBars',200)
    if len(payload['bars'])<wanted and not payload.get('historyPage',{}).get('boundaryReached',payload.get('brokerLimited') is True):
        raise ContractError('HISTORY_STILL_HYDRATING')
    return payload

def persist_backfill_request(spool,payload,result):
    # Server policy owns the cursor; transport accepts only the same series.
    for hint in result.get('nextBackfillHints',[]):
        if any(hint.get(k)!=payload.get(k) for k in ('symbol','brokerSymbol','timeframe')):continue
        identity=hint.get('historyIdentity','')
        if len(identity)!=64 or any(c not in '0123456789abcdef' for c in identity):continue
        raw=hint.get('suggestedEndTimeRaw')
        cursor=timestamp_ms(raw) if raw is not None else 0
        if not math.isfinite(cursor) or cursor<0:continue
        if cursor and cursor>=payload.get('brokerServerTime',payload['sentAt']):continue
        if not cursor and hint.get('status')!='COMPLETE':continue
        target=spool/('backfill-request-'+payload['symbol']+'-'+payload['timeframe']+'.txt')
        calendar.atomic_write(target,str(int(cursor/1000)).encode())


def run():
    os.umask(0o077)
    lock=(SERVICE/'relay.lock').open('w');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);lock.write(str(os.getpid()));lock.flush()
    logger=logging.getLogger('market_relay');logger.setLevel(logging.INFO)
    handler=RotatingFileHandler(SERVICE/'relay.log',maxBytes=1024*1024,backupCount=3);logger.addHandler(handler)
    evidence=SERVICE/'accepted-evidence';evidence.mkdir(exist_ok=True)
    stop=threading.Event()
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *_:stop.set())
    token=calendar.load_token();relay_id=uuid.uuid4().hex[:12];sequences={};last_quote=None;history_marks={};pending=set();scheduled={};attempts={};history_retry_after={}
    state={'mode':'read-only-market-data','pid':os.getpid(),'relayId':relay_id,'startedAt':calendar.now_iso(),'quoteBatchesAccepted':0,'quoteMessagesAccepted':0,'historySeries':{},'expectedHistorySeries':len(UNIVERSE)*len(SUPPORTED_TIMEFRAMES),'transportErrors':0}
    mutex=threading.Lock();fast_executors=[]
    def opener():return urllib.request.build_opener(urllib.request.ProxyHandler({}),calendar.NoRedirect())
    # Public liveness metadata, no token/header or user/account data. Restore
    # accepted seed receipts only after proving they belong to this API boot.
    try:
        with opener().open(calendar.BASE_URL+'/api/healthz',timeout=5) as health_response:
            health=json.loads(health_response.read(8192));boot=api_boot_upper_ms(health)
        state['apiBootUpperMs']=boot;restored=0
        for receipt_path in evidence.glob('*.json'):
            if receipt_path.name.startswith('fast-') or receipt_path.name=='last-accepted-quotes.json':continue
            proof=json.loads(calendar.read_regular(receipt_path));payload=proof.get('payload') or {}
            if payload.get('symbol') not in UNIVERSE or payload.get('brokerSymbol') not in UNIVERSE[payload['symbol']] or payload.get('timeframe') not in SUPPORTED_TIMEFRAMES:continue
            mark=restore_seed(proof,boot,int(time.time()*1000),time.monotonic())
            if mark is None:continue
            key=payload['symbol']+'|'+payload['timeframe'];history_marks[key]=mark;restored+=1
            state['historySeries'][key]={'http':200,'accepted':True,'acceptedBars':mark[2],'rejectedBars':0,'sentBars':mark[2],'brokerSymbol':payload['brokerSymbol'],'latestOpenTimeMs':mark[0],'at':proof['acceptedAt'],'restoredSameApiBoot':True,'brokerLimited':mark[3]}
        state['restoredSameApiBootSeeds']=restored
    except Exception as exc:state['seedRestoreErrorType']=type(exc).__name__
    def history_job(path,stamp):
        key=path.stem;retry=False
        try:
            if stop.is_set():return
            observation=json.loads(calendar.read_regular(path));now=int(time.time()*1000)
            for series in observation.get('series',[]):
                if stop.is_set():break
                series_key=str(series.get('canonical'))+'|'+str(series.get('timeframe'))
                with mutex:state.setdefault('historyCoverage',{})[series_key]={'observedBars':max(0,series.get('copyCount',0)),'requestedBars':series.get('requestedHistoryBars',200),'collectorError':series.get('error'),'fullRequestCount':series.get('fullRequestCount'),'fullRequestError':series.get('fullRequestError'),'brokerHistoryBoundaryReached':series.get('brokerHistoryBoundaryReached'),'localFirstHistoryServer':series.get('localFirstHistoryServer'),'serverFirstHistoryServer':series.get('serverFirstHistoryServer'),'status':'unavailable' if series.get('copyCount',0)<=0 or series.get('error')!=0 else 'partial' if series['copyCount']<200 else 'seed_ready','at':calendar.now_iso()}
                try:payload=full_history_payload(series,observation,now)
                except ContractError as exc:
                    with mutex:state['historyCoverage'][series_key]['validationError']=str(exc)
                    continue
                with mutex:mark=history_marks.get(series_key)
                # Reseed after process restart and every five minutes, retaining original observation time.
                backfill=payload.get('historyPage',{}).get('kind')=='backfill'
                if backfill:
                    request=SPOOL/('backfill-request-'+payload['symbol']+'-'+payload['timeframe']+'.txt')
                    if int(calendar.read_regular(request).strip())*1000!=payload['historyPage']['requestedEndRawMs']:continue
                full=backfill or needs_full_history(mark,len(payload['bars']),payload.get('brokerLimited'),time.monotonic())
                if not full:continue
                status,result=deliver(opener(),token,CANDLE_ROUTE,payload)
                retry=retry or retryable_history_status(status)
                accepted=status==200 and result.get('ok') is True and result.get('acceptedBars')==len(payload['bars']) and result.get('rejectedBars')==0
                with mutex:
                    state['historySeries'][series_key]={'http':status,'accepted':accepted,'acceptedBars':result.get('acceptedBars'),'rejectedBars':result.get('rejectedBars'),'sentBars':len(payload['bars']),'brokerSymbol':payload['brokerSymbol'],'latestOpenTimeMs':payload['bars'][-1]['openTime'],'at':calendar.now_iso()}
                    if accepted:
                        persist_backfill_request(SPOOL,payload,result)
                        history_marks[series_key]=(payload['bars'][-1]['openTime'],time.monotonic(),len(payload['bars']),payload.get('brokerLimited') is True)
                        if full:calendar.atomic_write(evidence/(payload['symbol']+'-'+payload['timeframe']+'.json'),json.dumps({'acceptedAt':calendar.now_iso(),'http':status,'result':result,'payload':payload}).encode())
                logger.info('history symbol=%s timeframe=%s http=%s accepted=%s bars=%s',payload['symbol'],payload['timeframe'],status,accepted,result.get('acceptedBars'))
        except Exception as exc:
            retry=isinstance(exc,(OSError,TimeoutError,urllib.error.URLError))
            with mutex:state['lastHistoryError']={'file':key,'type':type(exc).__name__,'at':calendar.now_iso()}
        finally:
            with mutex:
                pending.discard(path)
                if retry:
                    if scheduled.get(path)==stamp:scheduled.pop(path,None)
                    history_retry_after[path]=(stamp,time.monotonic()+HISTORY_RETRY_SECONDS)
                else:history_retry_after.pop(path,None)
    def fast_lane():
        marks={};inflight=set();retry_after={};last_attempt={};fast_lock=threading.Lock()
        def forward(payload,key):
            try:
                if stop.is_set():return
                status,result=deliver(opener(),token,CANDLE_ROUTE,payload)
                accepted=status==200 and result.get('ok') is True and result.get('acceptedBars')==len(payload['bars']) and result.get('rejectedBars')==0
                record={'http':status,'accepted':accepted,'bars':len(payload['bars']),'acceptedBars':result.get('acceptedBars'),'rejectedBars':result.get('rejectedBars'),'brokerSymbol':payload['brokerSymbol'],'latestOpenTimeMs':payload['bars'][-1]['openTime'],'observationMs':payload['sentAt'],'acceptedAt':calendar.now_iso()}
                with mutex:state.setdefault('fastSeries',{})[key]=record
                if accepted:
                    with fast_lock:marks[key]=(payload['bars'][-1]['openTime'],time.monotonic())
                    calendar.atomic_write(evidence/('fast-'+payload['symbol']+'-'+payload['timeframe']+'.json'),json.dumps({'acceptedAt':record['acceptedAt'],'http':status,'result':result,'payload':payload}).encode())
                else:
                    with fast_lock:retry_after[key]=time.monotonic()+3
            except Exception as exc:
                with mutex:state['lastFastError']={'type':type(exc).__name__,'at':calendar.now_iso()}
                with fast_lock:retry_after[key]=time.monotonic()+3
            finally:
                with fast_lock:inflight.discard(key)
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as minute_pool, concurrent.futures.ThreadPoolExecutor(max_workers=3) as slow_pool:
            fast_executors.extend([minute_pool,slow_pool])
            while not stop.is_set():
                candidates=[]
                for name in ['fast-m1.json']+[p.name for p in sorted(SPOOL.glob('fast-extra-*.json'))]:
                    try:
                        observation=json.loads(calendar.read_regular(SPOOL/name));now=int(time.time()*1000)
                        validate_header(observation,now,max_age_ms=15000)
                        for series in observation.get('series',[]):
                            key=str(series.get('canonical'))+'|'+str(series.get('timeframe'))+'|'+str(series.get('brokerSymbol'))
                            with fast_lock:
                                if key in inflight or retry_after.get(key,0)>time.monotonic():continue
                                mark=marks.get(key)
                            try:payload=observed_tip_payload(series,observation,now,mark,time.monotonic())
                            except ContractError as exc:
                                with mutex:state.setdefault('rejectedFastSeries',{})[key]=str(exc)
                                continue
                            with mutex:state.setdefault('rejectedFastSeries',{}).pop(key,None)
                            if not payload['bars']:continue
                            with fast_lock:attempt=last_attempt.get(key,float('-inf'))
                            candidates.append((key,payload,mark,attempt))
                    except FileNotFoundError:pass
                    except Exception as exc:
                        with mutex:state['lastFastReadError']={'file':name,'type':type(exc).__name__,'at':calendar.now_iso()}
                for key,payload,mark,attempt in sorted(candidates,key=fast_candidate_rank):
                    minute=payload['timeframe']=='M1'
                    with fast_lock:
                        if not fast_lane_has_room(key,inflight):continue
                        inflight.add(key);last_attempt[key]=time.monotonic()
                    (minute_pool if minute else slow_pool).submit(forward,payload,key)
                with fast_lock:queue_counts={'M1':sum(key.split('|')[1]=='M1' for key in inflight),'other':sum(key.split('|')[1]!='M1' for key in inflight)}
                with mutex:state['fastLanePending']=queue_counts
                stop.wait(.25)
    fast_thread=threading.Thread(target=fast_lane,name='closed-bar-fast-lane',daemon=True);fast_thread.start()
    native_thread=threading.Thread(target=run_native_seam_lane,args=(stop,SERVICE,SPOOL,state,mutex,lambda payload:deliver(opener(),token,NATIVE_SEAM_ROUTE,payload)),name='native-seam-metadata',daemon=True);native_thread.start()
    pool=concurrent.futures.ThreadPoolExecutor(max_workers=HISTORY_PENDING_LIMIT)
    def history_lane():
        # Dispatch immediately when a worker finishes. Quote HTTP latency must
        # not gate the next three history jobs or age fresh files out of policy.
        while not stop.is_set():
            try:
                paths=list(SPOOL.glob('history-extra-*.json'))+list(SPOOL.glob('backfill-extra-*.json'))
                with mutex:paths=ordered_history_paths(paths,history_marks,attempts)
                for path in paths:
                    if stop.is_set():break
                    with mutex:
                        if len(pending)>=HISTORY_PENDING_LIMIT:break
                    stamp=path.stat().st_mtime_ns;now=time.monotonic()
                    with mutex:
                        if not history_dispatch_ready(path,stamp,pending,scheduled,history_retry_after,now):continue
                        pending.add(path);scheduled[path]=stamp;attempts[path]=now
                    pool.submit(history_job,path,stamp)
                with mutex:state['historyLanePending']=len(pending)
            except Exception as exc:
                with mutex:state['lastHistoryDispatchError']={'type':type(exc).__name__,'at':calendar.now_iso()}
            stop.wait(.25)
    history_thread=threading.Thread(target=history_lane,name='history-dispatch',daemon=True);history_thread.start()
    try:
        while not stop.is_set():
            try:
                observation=json.loads(calendar.read_regular(SPOOL/'quotes.json'));identity=(observation.get('instanceId'),observation.get('sequence'))
                if identity!=last_quote:
                    messages,rejected=tick_messages(observation,int(time.time()*1000),relay_id,sequences)
                    if messages:
                        status,result=deliver(opener(),token,TICK_ROUTE,{'messages':messages})
                        accepted=status==200 and result.get('accepted')==len(messages)
                        with mutex:
                            state.update(lastQuoteAt=calendar.now_iso(),lastQuoteHttp=status,lastQuoteAccepted=accepted,lastQuoteSent=len(messages),lastQuoteAcceptedCount=result.get('accepted'),lastQuoteRejected=rejected)
                            if accepted:
                                state['quoteBatchesAccepted']+=1;state['quoteMessagesAccepted']+=len(messages)
                                calendar.atomic_write(evidence/'last-accepted-quotes.json',json.dumps({'acceptedAt':calendar.now_iso(),'http':status,'accepted':result['accepted'],'observation':observation,'messages':messages}).encode())
                            else:state['lastQuoteOutcomes']=[{'accepted':r.get('accepted'),'outcome':r.get('outcome')} for r in result.get('results',[])][:5]
                    else:
                        with mutex:state.update(lastQuoteAccepted=False,lastQuoteRejected=rejected)
                    last_quote=identity
            except Exception as exc:
                with mutex:state['transportErrors']+=1;state['lastErrorType']=type(exc).__name__
            with mutex:calendar.atomic_write(SERVICE/'relay-status.json',json.dumps(state,indent=2).encode())
            stop.wait(.5)
    finally:
        stop.set()
        history_thread.join(timeout=5)
        for executor in fast_executors:executor.shutdown(wait=False,cancel_futures=True)
        pool.shutdown(wait=True,cancel_futures=True);fast_thread.join(timeout=25);native_thread.join(timeout=15);logger.info('service_stopped')
if __name__=='__main__':run()
