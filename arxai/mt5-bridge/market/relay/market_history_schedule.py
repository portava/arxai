"""Fair bounded history work and conservative same-API-boot seed recovery."""
from datetime import datetime
from pathlib import Path
import math

HISTORY_PENDING_LIMIT=3
HISTORY_RETRY_SECONDS=3
HISTORY_FILE_ADMISSION_AGE_MS=120000

def history_file_recent(stamp_ns,now_ms):
    # Atomic collector writes occur after the native observation. An already
    # old file cannot become a current observation by waiting in this queue.
    # This is only an admission filter; workers still verify the original
    # header clock, identity and read-only guards before every delivery.
    return stamp_ns/1000000>=now_ms-HISTORY_FILE_ADMISSION_AGE_MS

def history_dispatch_ready(path,stamp,pending,scheduled,retry_after,now):
    if path in pending or len(pending)>=HISTORY_PENDING_LIMIT or scheduled.get(path)==stamp:return False
    retry=retry_after.get(path)
    # A newly collected snapshot is eligible immediately. A transient failure
    # retries the same immutable snapshot only after a bounded cooldown; all
    # identity/freshness validation is rerun by the worker before delivery.
    return retry is None or retry[0]!=stamp or now>=retry[1]

def retryable_history_status(status):return status==429 or 500<=status<=599

def timestamp_ms(value):
    try:
        parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
        return parsed.timestamp()*1000 if parsed.tzinfo is not None else math.nan
    except (ValueError,TypeError,AttributeError):return math.nan

def api_boot_upper_ms(health):
    stamp=timestamp_ms(health.get('timestamp'));uptime=health.get('uptimeSeconds')
    if health.get('ok') is not True or type(uptime) is not int or uptime<0 or not math.isfinite(stamp):return None
    return stamp-uptime*1000

def history_key(path):
    name=Path(path).stem
    prefix=next((p for p in ('history-extra-','backfill-extra-') if name.startswith(p)),None)
    if prefix is None:return None
    bits=name[len(prefix):].rsplit('-',1)
    return '|'.join(bits) if len(bits)==2 else None

def resolved_depth(mark):return mark is not None and (mark[2]>=200 or mark[3] is True)

def ordered_history_paths(paths,marks,attempts):
    priority={'M15':0,'H4':1,'D1':2,'M30':3,'M1':4,'M5':5,'H1':6}
    def rank(path):
        key=history_key(path);tf=key.split('|')[1] if key else ''
        # Depth is only a tie-breaker. A repeatedly failing unresolved series
        # must not permanently outrank an older attempt on a seeded series.
        return (attempts.get(path,float('-inf')),1 if resolved_depth(marks.get(key)) else 0,priority.get(tf,10),str(path))
    return sorted(paths,key=rank)

def select_history_dispatch(paths,marks,attempts,pending):
    """Choose already-eligible paths within the existing three-worker limit.

    When both classes have work, give seeds and backfill at least one worker
    as slots free. The remaining slot follows oldest attempt. An idle class
    lends its slot; no extra executor or unbounded queue is introduced.
    """
    ordered=ordered_history_paths((p for p in paths if p not in pending),marks,attempts)
    occupied=set(pending);selected=[]
    def backfill(path):return Path(path).name.startswith('backfill-extra-')
    while ordered and len(occupied)<HISTORY_PENDING_LIMIT:
        waiting_backfill=next((p for p in ordered if backfill(p)),None)
        waiting_seed=next((p for p in ordered if not backfill(p)),None)
        has_backfill=any(backfill(p) for p in occupied)
        has_seed=any(not backfill(p) for p in occupied)
        if waiting_backfill is not None and not has_backfill:
            chosen=waiting_backfill
        elif waiting_seed is not None and not has_seed:
            chosen=waiting_seed
        else:chosen=ordered[0]
        ordered.remove(chosen);selected.append(chosen);occupied.add(chosen)
    return selected

def needs_full_history(mark,depth,broker_limited,now):
    return mark is None or now-mark[1]>=300 or depth>mark[2] or (broker_limited is True and mark[3] is not True)

def restore_seed(proof,boot_upper_ms,now_ms,monotonic_now):
    if boot_upper_ms is None:return None
    accepted=timestamp_ms(proof.get('acceptedAt'));payload=proof.get('payload') or {};bars=payload.get('bars') or [];result=proof.get('result') or {}
    # Five-second margin excludes uncertain boot-boundary receipts. This only
    # restores a receipt, never rewrites or resends its historical payload.
    if not math.isfinite(accepted) or accepted<boot_upper_ms+5000 or accepted>now_ms+1000:return None
    if proof.get('http')!=200 or result.get('ok') is not True or not 1<=len(bars)<=200 or result.get('acceptedBars')!=len(bars) or result.get('rejectedBars')!=0:return None
    opened=bars[-1].get('openTime')
    if type(opened) is not int or opened<=0:return None
    return (opened,monotonic_now-max(0,(now_ms-accepted)/1000),len(bars),payload.get('brokerLimited') is True)
