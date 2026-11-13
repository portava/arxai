"""Strict read-only market-observation validation; no network or broker actions."""
from pathlib import Path
import json,math
from datetime import datetime,timezone
UNIVERSE={row['canonical']:set(row['aliases']) for row in json.loads(Path(__file__).with_name('universe.json').read_text())}
ACCOUNT='62249354'
SERVER='DerivSVG-Server'
class ContractError(ValueError): pass

def integer(value):return type(value) is int

def number(value):return type(value) in (int,float) and math.isfinite(value)

def validate_header(value,now_ms,max_age_ms=5000):
    if not isinstance(value,dict) or type(value.get('version')) is not int or value['version']!=1:raise ContractError('VERSION_INVALID')
    if (value.get('account')!=ACCOUNT or value.get('server')!=SERVER or value.get('readOnly') is not True
        or value.get('algoTradingAllowed') is not False or value.get('tester') is not False or value.get('terminalConnected') is not True):raise ContractError('IDENTITY_OR_READ_ONLY_GUARD_FAILED')
    if not isinstance(value.get('instanceId'),str) or not 1<=len(value['instanceId'])<=100 or not integer(value.get('sequence')) or value['sequence']<=0:raise ContractError('SEQUENCE_INVALID')
    if not all(integer(value.get(k)) for k in ['observedAtUtc','serverNow','lastQuoteServer']):raise ContractError('CLOCK_EVIDENCE_MISSING')
    observed=value['observedAtUtc']*1000
    if observed>now_ms+1000 or now_ms-observed>max_age_ms:raise ContractError('OBSERVATION_STALE_OR_FUTURE')
    # Current broker timezone was independently observed as UTC. Any change must
    # be investigated rather than estimated from the incoming tick itself.
    if abs(value['serverNow']-value['observedAtUtc'])>1 or not -1<=value['serverNow']-value['lastQuoteServer']<=5:raise ContractError('BROKER_CLOCK_UNVERIFIED')
    return observed

def bound_quote(row,observation,now_ms):
    observed=validate_header(observation,now_ms)
    if not isinstance(row,dict):raise ContractError('QUOTE_INVALID')
    canonical=row.get('canonical');broker=row.get('brokerSymbol')
    if canonical not in UNIVERSE or broker not in UNIVERSE[canonical]:raise ContractError('SYMBOL_IDENTITY_UNVERIFIED')
    if any(row.get(k) is not True for k in ['available','selected','synchronized','tickAvailable']):raise ContractError('SYMBOL_OR_TICK_UNAVAILABLE')
    if row.get('tradeMode')!=4:raise ContractError('SYMBOL_NOT_FULL_TRADE_MODE')
    bid,ask,tick=row.get('bid'),row.get('ask'),row.get('tickTimeServerMs')
    if not number(bid) or not number(ask) or bid<=0 or ask<bid:raise ContractError('BID_ASK_INVALID')
    if not integer(tick) or tick<=0 or tick>now_ms+1000 or now_ms-tick>5000 or tick>observed+1000:raise ContractError('TICK_TIME_STALE_OR_FUTURE')
    if row.get('tickError')!=0:raise ContractError('MT5_TICK_ERROR')
    return {'symbol':canonical,'brokerSymbol':broker,'bid':bid,'ask':ask,'brokerTimeEpochMs':tick,'eaObservedAtEpochMs':observed,
        'account':observation['account'],'server':observation['server'],'digits':row.get('digits'),'tradeMode':row['tradeMode']}

TIMEFRAME_SECONDS={**{'M'+str(n):n*60 for n in [1,2,3,4,5,6,10,12,15,20,30]},**{'H'+str(n):n*3600 for n in [1,2,3,4,6,8,12]},'D1':86400,'W1':604800}
SUPPORTED_TIMEFRAMES=set(TIMEFRAME_SECONDS)|{'MN1'}
def candle_close_seconds(open_seconds,timeframe):
    if timeframe=='MN1':
        value=datetime.fromtimestamp(open_seconds,timezone.utc)
        if value.day!=1 or value.hour or value.minute or value.second:raise ContractError('MONTHLY_OPEN_NOT_CALENDAR_BOUNDARY')
        return int(datetime(value.year+(value.month==12),1 if value.month==12 else value.month+1,1,tzinfo=timezone.utc).timestamp())
    return open_seconds+TIMEFRAME_SECONDS[timeframe]

def candle_payload(series,observation,now_ms):
    observed=validate_header(observation,now_ms,max_age_ms=120000)
    if series.get('canonical') not in UNIVERSE or series.get('brokerSymbol') not in UNIVERSE[series['canonical']]:raise ContractError('SYMBOL_IDENTITY_UNVERIFIED')
    tf=series.get('timeframe')
    if tf not in SUPPORTED_TIMEFRAMES or series.get('closedOnly') is not True or series.get('chartPriceBasis') not in ('bid','last'):raise ContractError('CANDLE_BASIS_UNVERIFIED')
    bars=series.get('bars')
    if series.get('error')!=0 or not isinstance(bars,list) or not bars or len(bars)>5000 or series.get('copyCount')!=len(bars):raise ContractError('CANDLE_COPY_INCOMPLETE')
    result=[];last=0
    for bar in bars:
        ts=bar.get('openTimeServer')
        if not integer(ts) or ts<=last:raise ContractError('CANDLE_TIME_OR_CLOSED_STATE_INVALID')
        close_ts=candle_close_seconds(ts,tf)
        if close_ts>observation['serverNow']:raise ContractError('CANDLE_TIME_OR_CLOSED_STATE_INVALID')
        o,h,l,c=(bar.get(k) for k in ['open','high','low','close'])
        if not all(number(x) and x>0 for x in [o,h,l,c]) or l>min(o,c) or h<max(o,c) or l>h:raise ContractError('CANDLE_OHLC_INVALID')
        if not integer(bar.get('tickVolume')) or bar['tickVolume']<0:raise ContractError('CANDLE_VOLUME_INVALID')
        result.append({'openTime':ts*1000,'closeTime':close_ts*1000,'open':o,'high':h,'low':l,'close':c,'tickVolume':bar['tickVolume'],'spread':bar.get('spreadPoints'),'isClosed':True})
        last=ts
    payload={'symbol':series['canonical'],'brokerSymbol':series['brokerSymbol'],'timeframe':tf,'priceBasis':series['chartPriceBasis'],
        'accountNumber':observation['account'],'serverName':observation['server'],'clockBasis':'broker_server','terminalId':observation['instanceId'],'source':'mt5_ea','eaVersion':'1.55-readonly-market-observer',
        'brokerLimited':series.get('historyDepthPartial') is True and series.get('brokerHistoryBoundaryReached') is True,'brokerServerTime':observation['serverNow']*1000,'sentAt':observation['observedAtUtc']*1000,'bars':result}

    if series.get('historyKind') in ('seed','backfill'):
        requested=series.get('requestedHistoryBars');first=series.get('serverFirstHistoryServer');end=series.get('requestedEndServer')
        if not integer(requested) or not 1<=requested<=5000 or not integer(first) or first<0:raise ContractError('HISTORY_PROOF_INVALID')
        boundary=series.get('brokerHistoryBoundaryReached') is True
        if boundary and not (bars[0]['openTimeServer']<=first<candle_close_seconds(bars[0]['openTimeServer'],tf)):raise ContractError('HISTORY_BOUNDARY_NOT_IN_PAGE')
        proof={'kind':series['historyKind'],'serverFirstRawMs':first*1000,'requestedBars':requested,'copiedBars':len(bars),'boundaryReached':boundary}
        if proof['kind']=='backfill':
            if not integer(end) or end<=0 or bars[-1]['openTimeServer']>end:raise ContractError('HISTORY_CURSOR_INVALID')
            proof['requestedEndRawMs']=end*1000
        payload['historyPage']=proof
    return payload
