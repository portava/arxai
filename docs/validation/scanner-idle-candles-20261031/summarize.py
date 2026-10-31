import json,sys
from pathlib import Path
for name in sys.argv[1:]:
 s=Path(name+'.log').read_text()
 if '### Result\n' not in s: print(name,s[-700:]);continue
 r=json.JSONDecoder().raw_decode(s.split('### Result\n',1)[1])[0];Path(name+'.json').write_text(json.dumps(r,indent=2)+'\n')
 print(name,json.dumps({'passed':r.get('passed'),'failure':r.get('failure'),'build':r.get('build',{}).get('buildId'),'source':r.get('build',{}).get('source',{}).get('head'),'summary':r.get('summary'),'invalid':[{k:s.get(k) for k in ['viewport','index','failure','readyToClickMs','acceptance']} for s in r.get('samples',[]) if not s.get('acceptance',{}).get('valid')]}))
