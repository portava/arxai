import json,collections,statistics,pathlib
root=pathlib.Path(__file__).resolve().parent
d=json.loads((root/'trace.json').read_text());events=d['trace']['traceEvents']
clicks=[e for e in events if e.get('name')=='EventDispatch' and e.get('args',{}).get('data',{}).get('type')=='click']
samples=d['navigation']['samples']
if len(clicks)!=10 or len(samples)!=10:raise ValueError('Expected exactly ten clicks and ten navigation attempts; cannot silently pair a partial run')
rows=[]
for i,(click,sample) in enumerate(zip(clicks,samples)):
 if sample.get('trusted') is not True or sample.get('visibleCompleteMs') is None:raise ValueError('Missing click/completion evidence; do not turn null into zero')
 start=click['ts'];end=start+sample['visibleCompleteMs']*1000
 window=[e for e in events if e.get('ph')=='X' and e.get('pid')==click['pid'] and e.get('tid')==click['tid'] and e.get('ts',0)<end and e.get('ts',0)+e.get('dur',0)>start]
 sums=collections.Counter()
 for e in window:sums[e['name']]+=max(0,min(end,e['ts']+e['dur'])-max(start,e['ts']))/1000
 rows.append({'index':i,'viewport':sample['viewport'],'trustedClickDispatchMs':click['dur']/1000,'diagnosticVisibleMs':sample['visibleCompleteMs'],'acceptance':sample['acceptance'],'inclusiveEventMs':dict(sums)})
summary={'diagnosticOnly':True,'source':d['navigation']['build'],'cpuThrottle':d['cpuThrottle'],'eventCount':len(events),'samples':rows,'limits':['Event categories overlap/nest; never sum them as exclusive costs.','Click events paired in order with all ten trusted navigation samples; windows begin at trace dispatch, not the earlier input timestamp.','Tracing adds overhead. These are diagnostic values, not ordinary latency acceptance.','No source/visibility gates relaxed; no dropped attempts.'], 'viewports':{}}
for viewport in ['desktop','mobile']:
 selected=[r for r in rows if r['viewport']==viewport]
 summary['viewports'][viewport]={'n':len(selected),'dispatchMinMaxMs':[min(r['trustedClickDispatchMs'] for r in selected),max(r['trustedClickDispatchMs'] for r in selected)],'visibleMinMaxMs':[min(r['diagnosticVisibleMs'] for r in selected),max(r['diagnosticVisibleMs'] for r in selected)],'medianInclusiveMs':{name:statistics.median(r['inclusiveEventMs'].get(name,0) for r in selected) for name in ['FunctionCall','UpdateLayoutTree','Layout','Paint','TimerFire','FireAnimationFrame']}}
(root/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary['viewports'],indent=2))
