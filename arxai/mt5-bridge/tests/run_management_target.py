"""Compile actual MQL poll/management handlers against an offline fake terminal.
No MetaEditor/terminal/broker I/O. --baseline-dir checks prior source behavior.
"""
from pathlib import Path
import argparse, os, shutil, subprocess, tempfile, re
parser=argparse.ArgumentParser();parser.add_argument('--baseline-dir');parser.add_argument('--benchmark',action='store_true');parser.add_argument('--wire-file');args=parser.parse_args()
root=Path(__file__).resolve().parents[1]
source_root=Path(args.baseline_dir) if args.baseline_dir else root
compiler=shutil.which(os.environ.get('CXX','c++'))
if not compiler: raise SystemExit('C++ compiler required; no silent skip')
def function(source,name):
 start=re.search(r'^(?:void|bool|int|long|double|string)\s+'+name+r'\(',source,re.M).start();p=source.index('{',start);depth=0;state='code'
 for i in range(p,len(source)):
  c=source[i];prev=source[i-1] if i else '';nxt=source[i+1:i+2]
  if state=='line':
   if c=='\n':state='code'
   continue
  if state=='block':
   if prev=='*' and c=='/':state='code'
   continue
  if state in ['"',"'"]:
   if c==state:
    slashes=0;j=i-1
    while j>=0 and source[j]=='\\':slashes+=1;j-=1
    if slashes%2==0:state='code'
   continue
  if c=='/' and nxt=='/':state='line';continue
  if c=='/' and nxt=='*':state='block';continue
  if c in ['"',"'"]:state=c;continue
  if c=='{':depth+=1
  if c=='}':
   depth-=1
   if depth==0:return source[start:i+1]
 raise ValueError(name)
v131=(source_root/'ReplitMT5BridgeEA_v131.mq5').read_text();v154=(source_root/'ARX_AI_Universal_Agent_v154.mq5').read_text()
with tempfile.TemporaryDirectory(prefix='arx-terminal-target-') as folder:
 folder=Path(folder)
 wire='\n'.join(function(v131,n) for n in ['JsonReadInt','JsonReadDouble','JsonReadString','LiveDoneIndexOf','LiveDoneRecord','PollAndExecuteLiveCommands'])
 wire+='\n'+'\n'.join(function(v154,n) for n in ['JsonStr','JsonNum','JsonLong','HandleClosePosition','HandleModifyProtection','IsReadOnlyAction','IsEntryAction','HandleCommand','PollAndExecute'])
 (folder/'management_wire.inc').write_text(wire)
 binary=folder/'management_target'
 subprocess.run([compiler,'-std=c++17','-O2','-Wall','-Wextra','-Werror','-I',str(folder),'-I',str(root),
  '-DARX_BASELINE='+('1' if args.baseline_dir else '0'),str(root/'tests/management_target_test.cpp'),'-o',str(binary)],check=True)
 subprocess.run([str(binary)]+(['--benchmark'] if args.benchmark else ['--wire-file',args.wire_file] if args.wire_file else []),check=True)
