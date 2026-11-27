"""Offline only. Run with input exported by exportForecastLibraryBenchmark.ts."""
import hashlib, json, sys, warnings
from importlib.metadata import version
from pathlib import Path
import numpy as np
from arch import arch_model
from statsforecast.models import Naive
from statsforecast.utils import ConformalIntervals
from river.drift import ADWIN

CHECKS = np.array([15, 30, 60])
MODELS = ('arx', 'garch', 'conformal')

def score(lo, hi, y):
    return float(np.sum(hi-lo+4*np.maximum(0,lo-y)+4*np.maximum(0,y-hi)))

def intervals(past):
    # Never pass held-out closes to either library.
    log = np.log(np.asarray(past[-1261:],dtype=float))
    bands, errors = {}, {}
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            fit = arch_model(100*np.diff(log),mean='Zero',vol='GARCH',p=1,q=1,dist='normal',rescale=False).fit(disp='off',show_warning=False)
        if fit.convergence_flag:
            raise ValueError(f'GARCH optimizer convergence={fit.convergence_flag}')
        variance = fit.forecast(horizon=60,reindex=False).variance.values[-1]/10000
        width = .6745*np.sqrt(np.cumsum(variance)[CHECKS-1])
        bands['garch'] = (np.expm1(-width),np.expm1(width))
    except Exception as exc:
        errors['garch'] = str(exc)
    try:
        pred = Naive(prediction_intervals=ConformalIntervals(n_windows=20,h=60)).forecast(y=log,h=60,level=[50])
        bands['conformal'] = (np.expm1(pred['lo-50'][CHECKS-1]-log[-1]),np.expm1(pred['hi-50'][CHECKS-1]-log[-1]))
    except Exception as exc:
        errors['conformal'] = str(exc)
    for name,(lo,hi) in list(bands.items()):
        if not (np.isfinite(lo).all() and np.isfinite(hi).all() and (lo<=hi).all()):
            errors[name] = 'nonfinite or inverted interval'
            del bands[name]
    return bands, errors

def bootstrap(groups):
    rng=np.random.default_rng(20261117)
    means=[]
    for _ in range(2000):
        sample=[]
        for k in rng.integers(0,len(groups),len(groups)):
            g=np.asarray(groups[k]); n=len(g)
            starts=rng.integers(0,n,(n+7)//8)
            sample.extend(g[((starts[:,None]+np.arange(8))%n).ravel()[:n]])
        means.append(float(np.mean(sample)))
    return [float(x) for x in np.quantile(means,[.025,.975])]

def run(source, destination):
    raw=Path(source).read_bytes(); data=json.loads(raw); rows=[]; failures=[]
    for series in data['series']:
        closes=np.array(series['closes']); results=[]; drift=ADWIN(delta=.002); drift_events=[]
        for origin in series['origins']:
            i=origin['index']; y=closes[i-1+CHECKS]/closes[i-1]-1
            bands={'arx':(np.array(origin['lo']),np.array(origin['hi']))}
            candidates, errors = intervals(closes[:i])
            bands.update(candidates)
            for model, error in errors.items():
                failures.append({'model':model,'symbol':series['symbol'],'timeframe':series['timeframe'],'index':i,'error':error})
                # Failed candidates retain ARX; every forecast remains in denominator.
                bands[model] = bands['arx']
            observation={'index':i,'scores':{},'inside':{}}
            for model,(lo,hi) in bands.items():
                observation['scores'][model]=score(lo,hi,y)
                observation['inside'][model]=((lo<=y)&(y<=hi)).astype(int).tolist()
            # This outcome closes at i+59, which is before the next origin.
            drift.update(1-observation['inside']['arx'][-1])
            if drift.drift_detected: drift_events.append({'observedThrough':series['times'][i+59],'index':i})
            results.append(observation)
        base=np.mean([r['scores']['arx'] for r in results]); variants={}
        for model in MODELS:
            matched=[r for r in results if model in r['scores']]
            gains=[(r['scores']['arx']-r['scores'][model])/base for r in matched]
            half=len(matched)//2
            variants[model]={'n':len(matched),'meanScore':float(np.mean([r['scores'][model] for r in matched])),
                'coverageByHorizon':np.mean([r['inside'][model] for r in matched],axis=0).tolist(),
                'meanNormalizedGain':float(np.mean(gains)), 'firstHalfGain':float(np.mean(gains[:half])),
                'lastHalfGain':float(np.mean(gains[half:])), 'gains':gains}
        rows.append({'symbol':series['symbol'],'timeframe':series['timeframe'],'variants':variants,'adwinEvents':drift_events})
        print(series['symbol'],series['timeframe'],len(results),flush=True)
    summary={}
    for model in ('garch','conformal'):
        groups=[r['variants'][model]['gains'] for r in rows]
        summary[model]={'n':sum(map(len,groups)),'meanNormalizedGain':float(np.mean([g for group in groups for g in group])),
            'hierarchicalBlockBootstrap95':bootstrap(groups),'seriesBetter':int(sum(np.mean(g)>0 for g in groups))}
    for row in rows:
        for v in row['variants'].values(): del v['gains']
    report={'protocolSha256':hashlib.sha256(Path(__file__).with_name('PROTOCOL.md').read_bytes()).hexdigest(),
        'inputSha256':hashlib.sha256(raw).hexdigest(),'packages':{p:version(p) for p in ('arch','statsforecast','river','numpy')},
        'status':'EXPLORATORY_REUSED_HISTORY_NO_PROMOTION','summary':summary,'failures':failures,'series':rows}
    Path(destination).write_text(json.dumps(report,indent=2))
    print(json.dumps(summary,indent=2));print('failures',len(failures))

if __name__=='__main__': run(*sys.argv[1:])
