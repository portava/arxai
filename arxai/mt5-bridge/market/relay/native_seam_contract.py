"""Native shift1/shift0 evidence only; never a closed-candle or trading payload."""
import copy
from market_observation_contract import ContractError, UNIVERSE, SUPPORTED_TIMEFRAMES, integer, number, validate_header, candle_close_seconds
NATIVE_SEAM_ROUTE='/api/bridge/v2/native-seams'
OBSERVATION_FIELDS={'symbol','brokerSymbol','timeframe','collectedAtEpochMs','brokerServerTimeEpochMs','brokerUtcOffsetMs','lastClosed','forming'}
BAR_FIELDS={'openTimeEpochMs','open','high','low','close'}

def validate_bar(bar):
    if not isinstance(bar,dict) or set(bar)!=BAR_FIELDS:raise ContractError('NATIVE_SEAM_BAR_SHAPE_INVALID')
    opened=bar.get('openTimeEpochMs')
    if not integer(opened) or opened<=0 or opened%1000:raise ContractError('NATIVE_SEAM_BAR_TIME_INVALID')
    o,h,l,c=(bar.get(k) for k in ['open','high','low','close'])
    if not all(number(v) and v>0 for v in [o,h,l,c]) or l>min(o,c) or h<max(o,c) or l>h:raise ContractError('NATIVE_SEAM_OHLC_INVALID')

def native_seam_observation(series,snapshot,now_ms):
    header_ms=validate_header(snapshot,now_ms,max_age_ms=15000)
    seam=series.get('nativeSeam')
    if not isinstance(seam,dict) or seam.get('available') is not True or not integer(seam.get('copyCount')) or seam.get('copyCount')!=2 or not integer(seam.get('error')) or seam.get('error')!=0 or seam.get('synchronized') is not True:raise ContractError('NATIVE_SEAM_UNAVAILABLE')
    observation=seam.get('observation')
    if not isinstance(observation,dict) or set(observation)!=OBSERVATION_FIELDS:raise ContractError('NATIVE_SEAM_SHAPE_INVALID')
    symbol,broker,tf=(observation.get(k) for k in ['symbol','brokerSymbol','timeframe'])
    if symbol not in UNIVERSE or broker not in UNIVERSE[symbol] or tf not in SUPPORTED_TIMEFRAMES:raise ContractError('NATIVE_SEAM_IDENTITY_INVALID')
    if symbol!=series.get('canonical') or broker!=series.get('brokerSymbol') or tf!=series.get('timeframe'):raise ContractError('NATIVE_SEAM_SERIES_MISMATCH')
    collected,server,offset=(observation.get(k) for k in ['collectedAtEpochMs','brokerServerTimeEpochMs','brokerUtcOffsetMs'])
    if not all(integer(v) for v in [collected,server,offset]) or collected<=0 or server<=0:raise ContractError('NATIVE_SEAM_CLOCK_INVALID')
    if collected>now_ms+1000 or collected>header_ms+1000 or now_ms-collected>120000:raise ContractError('NATIVE_SEAM_STALE_OR_FUTURE')
    # This collector is pinned to the independently observed Deriv UTC server.
    # Keep raw same-read second jitter; never round it into a claimed timezone.
    if server-collected!=offset or abs(offset)>1000:raise ContractError('NATIVE_SEAM_CLOCK_UNVERIFIED')
    previous,current=observation['lastClosed'],observation['forming'];validate_bar(previous);validate_bar(current)
    if previous['openTimeEpochMs']>=current['openTimeEpochMs']:raise ContractError('NATIVE_SEAM_PAIR_ORDER_INVALID')
    try:
        previous_close=candle_close_seconds(previous['openTimeEpochMs']//1000,tf)*1000
        current_close=candle_close_seconds(current['openTimeEpochMs']//1000,tf)*1000
    except (ValueError,OverflowError,KeyError) as exc:raise ContractError('NATIVE_SEAM_CALENDAR_INVALID') from exc
    if previous_close>current['openTimeEpochMs'] or current['openTimeEpochMs']>server or current_close<=server:raise ContractError('NATIVE_SEAM_NOT_CURRENT_PAIR')
    # Session gaps remain real evidence; do not synthesize a missing interval.
    return copy.deepcopy(observation)

def native_seam_batch(snapshot,now_ms):
    validate_header(snapshot,now_ms,max_age_ms=15000)
    observations=[];rejected={};seen=set()
    for series in snapshot.get('series',[]):
        key=str(series.get('canonical'))+'|'+str(series.get('timeframe'))
        try:
            observation=native_seam_observation(series,snapshot,now_ms)
            if key in seen:raise ContractError('NATIVE_SEAM_DUPLICATE_SERIES')
            seen.add(key);observations.append(observation)
        except ContractError as exc:rejected[key]=str(exc)
    if len(observations)>50:raise ContractError('NATIVE_SEAM_BATCH_TOO_LARGE')
    return {'observations':observations},rejected

def validate_native_envelope(payload):
    if not isinstance(payload,dict) or set(payload)!={'observations'} or not isinstance(payload['observations'],list) or not 1<=len(payload['observations'])<=50:raise ContractError('NATIVE_SEAM_ONLY_ENVELOPE_REQUIRED')
    for row in payload['observations']:
        if not isinstance(row,dict) or set(row)!=OBSERVATION_FIELDS:raise ContractError('NATIVE_SEAM_ONLY_ENVELOPE_REQUIRED')

def bound_native_results(payload,status,result):
    observations=payload['observations'];rows=result.get('results') if isinstance(result,dict) else None
    if not isinstance(result,dict) or status!=200 or result.get('ok') is not True or result.get('received')!=len(observations) or not isinstance(rows,list) or len(rows)!=len(observations):raise ContractError('NATIVE_SEAM_RECEIPT_UNBOUND')
    accepted=0;bound=[]
    for index,(observation,row) in enumerate(zip(observations,rows)):
        if not isinstance(row,dict) or row.get('index')!=index or any(row.get(k)!=observation[k] for k in ['symbol','brokerSymbol','timeframe']) or type(row.get('accepted')) is not bool or not isinstance(row.get('reason'),str):raise ContractError('NATIVE_SEAM_RECEIPT_UNBOUND')
        accepted+=int(row['accepted']);bound.append(dict(row))
    if result.get('accepted')!=accepted or result.get('rejected')!=len(rows)-accepted:raise ContractError('NATIVE_SEAM_RECEIPT_COUNT_MISMATCH')
    return bound
