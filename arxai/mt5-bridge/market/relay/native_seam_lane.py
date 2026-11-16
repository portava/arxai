"""Bounded native-pair metadata forwarding, separate from all candle ingestion."""
import concurrent.futures,hashlib,json,threading,time
from native_seam_contract import native_seam_batch,bound_native_results
from market_transport import read_regular,atomic_write,now_iso
NATIVE_SEAM_RESEND_SECONDS=20

def native_pair_changed(payload,accepted_heads):
    # Only an actually observed native boundary/identity change bypasses the
    # steady cadence. No wall-clock inference or observation restamping.
    return any((o['symbol'],o['timeframe']) in accepted_heads and
      accepted_heads[(o['symbol'],o['timeframe'])]!=(o['brokerSymbol'],o['forming']['openTimeEpochMs'])
      for o in payload['observations'])

def run_native_seam_lane(stop,service,spool,state,mutex,deliver_batch):
    evidence=service/'native-seam-evidence';evidence.mkdir(exist_ok=True)
    pending=set();attempts={};due={};sent={};accepted_heads={};read_stamps={};lock=threading.Lock()
    def forward(path,source,payload):
        try:
            if stop.is_set():return
            status,result=deliver_batch(payload)
            rows=bound_native_results(payload,status,result)
            received=now_iso();proof={'acceptedAt':received,'http':status,'payload':payload,'result':result,'sourceSnapshotSha256':hashlib.sha256(json.dumps(source,sort_keys=True,separators=(',',':')).encode()).hexdigest(),'sourceSnapshot':source,'scope':'Native pair receipt only; matching the served closed series is evaluated independently by the API.'}
            atomic_write(evidence/(path.stem+'.json'),json.dumps(proof).encode())
            with mutex:
                state['lastNativeSeamReceiptAt']=received
                state['lastNativeSeamHttp']=status
                for row,observation in zip(rows,payload['observations']):
                    key=observation['symbol']+'|'+observation['timeframe']
                    state.setdefault('nativeSeamSeries',{})[key]={'accepted':row['accepted'],'reason':row['reason'],'brokerSymbol':observation['brokerSymbol'],'collectedAtEpochMs':observation['collectedAtEpochMs'],'receivedAt':received,'formingOpenTimeEpochMs':observation['forming']['openTimeEpochMs'],'lastClosedOpenTimeEpochMs':observation['lastClosed']['openTimeEpochMs'],'seamMeasurementNotAsserted':True}
            with lock:
                sent[path]=(source['instanceId'],source['sequence'])
                due[path]=time.monotonic()+(NATIVE_SEAM_RESEND_SECONDS if all(row['accepted'] for row in rows) else 3)
                heads=accepted_heads.setdefault(path,{})
                for row,observation in zip(rows,payload['observations']):
                    if row['accepted']:heads[(observation['symbol'],observation['timeframe'])]=(observation['brokerSymbol'],observation['forming']['openTimeEpochMs'])
        except Exception as exc:
            with mutex:state['lastNativeSeamError']={'file':path.name,'type':type(exc).__name__,'at':now_iso()}
            with lock:due[path]=time.monotonic()+3
        finally:
            with lock:pending.discard(path)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        while not stop.is_set():
            paths=[spool/'fast-m1.json']+sorted(spool.glob('fast-extra-*.json'))
            with lock:paths=sorted(paths,key=lambda p:(attempts.get(p,float('-inf')),p.name))
            for path in paths:
                with lock:
                    if len(pending)>=2:break
                    if path in pending:continue
                    attempts[path]=time.monotonic()
                try:
                    stamp=path.stat().st_mtime_ns
                    with lock:
                        cadence_due=time.monotonic()>=due.get(path,0)
                        if not cadence_due and read_stamps.get(path)==stamp:continue
                    source=json.loads(read_regular(path))
                    with lock:read_stamps[path]=stamp
                    identity=(source.get('instanceId'),source.get('sequence'))
                    with lock:
                        if sent.get(path)==identity:continue
                    payload,rejected=native_seam_batch(source,int(time.time()*1000))
                    with lock:
                        if not cadence_due and not native_pair_changed(payload,accepted_heads.get(path,{})):continue
                    with mutex:
                        state.setdefault('nativeSeamCollection',{})[path.stem]={'validObservations':len(payload['observations']),'rejected':rejected,'at':now_iso()}
                    if not payload['observations']:
                        with lock:due[path]=time.monotonic()+3
                        continue
                    with lock:pending.add(path)
                    pool.submit(forward,path,source,payload)
                except FileNotFoundError:pass
                except Exception as exc:
                    with mutex:state['lastNativeSeamReadError']={'file':path.name,'type':type(exc).__name__,'at':now_iso()}
                    with lock:due[path]=time.monotonic()+3
            with lock:pending_count=len(pending)
            with mutex:state['nativeSeamPendingBatches']=pending_count
            stop.wait(.5)
        pool.shutdown(wait=True,cancel_futures=True)
