"""Offline execution of actual EA CopyRates producer functions, not native MQL compilation.
Only mechanical array/string syntax adaptations; no broker, database, terminal or HTTP I/O.
"""
from pathlib import Path
import argparse, json, os, re, shutil, subprocess, tempfile
parser=argparse.ArgumentParser(); parser.add_argument('--source-dir');parser.add_argument('--version',choices=['v151','v152','v154','kernel']);args=parser.parse_args()
root=Path(__file__).resolve().parents[1];source=Path(args.source_dir) if args.source_dir else root
compiler=shutil.which(os.environ.get('CXX','c++'))
if not compiler: raise SystemExit('C++ compiler required, no silent skip')
def function(text,name):
 match=re.search(r'^(?:void|bool|int|long|double|string)\s+'+name+r'\(',text,re.M)
 if not match:return ''
 start=match.start();pos=text.index('{',start);depth=0;state='code';escaped=False
 for i in range(pos,len(text)):
  c=text[i];prev=text[i-1] if i else '';nxt=text[i+1:i+2]
  if state=='line':
   if c=='\n':state='code'
   continue
  if state=='block':
   if prev=='*' and c=='/':state='code'
   continue
  if state in ['"',"'"]:
   if escaped:escaped=False
   elif c=='\\':escaped=True
   elif c==state:state='code'
   continue
  if c=='/' and nxt=='/':state='line';continue
  if c=='/' and nxt=='*':state='block';continue
  if c in ['"',"'"]:state=c;continue
  if c=='{':depth+=1
  if c=='}':
   depth-=1
   if depth==0:return text[start:i+1]
 raise ValueError(name)
total=0
for version in ([args.version] if args.version else ['v151','v152','v154','kernel']):
 name='ARX_AI_Bridge_v2_Beta_Kernel.mq5' if version=='kernel' else 'ARX_AI_Universal_Agent_'+version+'.mq5'
 text=(source/name).read_text()
 names=['ReadCandleChartBasis','ConfirmCandleChartBasis']
 if version!='kernel':names+=['BuildCandleBatchBody','ProcessCandleSeries']
 if version in ['v152','v154']:names+=['PushLiveCandleV2']
 if version=='kernel':names+=['PushClosedCandle']
 wire='\n'.join(function(text,n) for n in names)
 wire=re.sub(r'const MqlRates &([a-zA-Z]+)\[\]',r'const std::vector<MqlRates> &\1',wire)
 wire=wire.replace('(brokerLimited ? "true" : "false")','string(brokerLimited ? "true" : "false")')
 wire=re.sub(r'MqlRates ([a-zA-Z]+)\[\]',r'std::vector<MqlRates> \1',wire)
 with tempfile.TemporaryDirectory(prefix='arx-candle-mode-') as folder:
  folder=Path(folder);(folder/'candle_mode_wire.inc').write_text(wire)
  binary=folder/'check'
  subprocess.run([compiler,'-std=c++17','-O0','-Wall','-Wextra','-Werror','-I',str(folder),'-DUNIVERSAL='+str(int(version!='kernel')),'-DSTREAM='+str(int(version!='v151')),str(root/'tests/candle_chart_mode_test.cpp'),'-o',str(binary)],check=True)
  out=subprocess.run([str(binary)],capture_output=True,text=True)
  if out.returncode:raise AssertionError(version+': '+out.stderr)
  rows=[json.loads(line) for line in out.stdout.splitlines()]
  for row in rows:
   body=row['body'];expect=row['expect'];actual=body.get('priceBasis')
   assert actual==expect,(version,row['scenario'],actual,expect)
   assert body['symbol']==row['symbol'],(version,'symbol cross-contamination',row)
   if 'bars' in body:
    assert body['accountNumber']=='1234' and body['brokerSymbol']==row['symbol']
    assert len(body['bars'])==1 and body['bars'][0]['tickVolume']==17
    assert body['bars'][0]['open']==1.2
   else:assert body['open']==1.2 and body['volume']==17
   total+=1
  print(version+': '+str(len(rows))+' producer payload checks pass')
print(str(total)+' total extracted producer payload checks pass')
