"""Actual v154 native-account functions in an offline C++ terminal double.
No terminal/broker/runtime. Native MetaEditor remains a separate acceptance gate.
"""
from pathlib import Path
import argparse, hashlib, json, os, platform, re, shutil, subprocess, tempfile
parser=argparse.ArgumentParser();parser.add_argument('--source-dir');parser.add_argument('--emit-file');args=parser.parse_args()
root=Path(__file__).resolve().parents[1]; source=Path(args.source_dir) if args.source_dir else root
text=(source/'ARX_AI_Universal_Agent_v154.mq5').read_text()
compiler=shutil.which(os.environ.get('CXX','c++'))
if not compiler:raise SystemExit('C++ compiler required; no silent skip')
def function(name):
 match=re.search(r'^(?:void|bool|string|long)\s+'+name+r'\([^;]*?\)\s*\{',text,re.M)
 if not match:raise AssertionError('Missing native account producer function: '+name)
 start=match.start();pos=text.index('{',match.start());depth=0;state='code';escape=False
 for i in range(pos,len(text)):
  c=text[i];prev=text[i-1] if i else '';nxt=text[i+1:i+2]
  if state=='line':
   if c=='\n':state='code'
   continue
  if state=='block':
   if prev=='*' and c=='/':state='code'
   continue
  if state in ['"',"'"]:
   if escape:escape=False
   elif c=='\\':escape=True
   elif c==state:state='code'
   continue
  if c=='/' and nxt=='/':state='line';continue
  if c=='/' and nxt=='*':state='block';continue
  if c in ['"',"'"]:state=c;continue
  if c=='{':depth+=1
  if c=='}':
   depth-=1
   if depth==0:return text[start:i+1]
 raise AssertionError('Unterminated '+name)
names=['V2NextSequence','JsonEscape','NativeAccountSha256','NativeAccountIdentity','NativeAccountMoney','CaptureNativeAccountReport','OnTradeTransaction','ClearNativeAccountPending','QueueNativeAccountReport','PumpNativeAccountReport','NativeJsonSpace','NativeJsonString','NativeJsonValue','NativeJsonField','NativeAccountAcknowledged','SendNativeAccountPending']
# Structural wiring checks bind the standalone pump/callback tests to the EA.
assert 'PumpNativeAccountReport();' in function('OnTimer')
assert function('OnTimer').rfind('PumpNativeAccountReport();')>function('OnTimer').rfind('PollAndExecute();')
callback=function('OnTradeTransaction');assert 'WebRequest' not in callback and 'Magic' not in callback and 'OrderSend' not in callback
blocks=[function(n) for n in names]
def translate(s):
 s=re.sub(r'\b(uchar|char)\s+(\w+)\[\]',r'std::vector<\1> \2',s)
 # Only MQL scalar-to-string casts; preserve original arithmetic expressions.
 while '(string)' in s:
  i=s.index('(string)');p=i+8
  if s[p]=='(':
   depth=1;j=p+1
   while depth:
    if s[j]=='(':depth+=1
    if s[j]==')':depth-=1
    j+=1
   expr=s[p+1:j-1]
  else:
   m=re.match(r'\w+(?:\([^()]*\))?',s[p:]);assert m
   expr=m.group();j=p+len(expr)
  s=s[:i]+'std::to_string('+expr+')'+s[j:]
 return s
blocks=[translate(b) for b in blocks]
globals='\n'.join(re.findall(r'^#define\s+V2_(?:MAX_LIVE_SYMBOLS|MAX_LIVE_TFS|STREAM_CAPACITY|SEQUENCE_CAPACITY)\b.*$',text,re.M))+'\n'+'\n'.join(re.findall(r'^(?:string|long|int)\s+v2Seq(?:Keys|Next|Count)\b.*?;',text,re.M))+'\n'+'\n'.join(re.findall(r'^(?:string|ulong|bool|int|long)\s+nativeAccount\w+\s*=.*?;',text,re.M))
interval=re.search(r'input\s+int\s+NativeAccountIntervalSeconds\s*=\s*(\d+)\s*;',text);assert interval
with tempfile.TemporaryDirectory(prefix='arx-native-account-') as folder:
 folder=Path(folder);wire=globals+'\nint NativeAccountIntervalSeconds='+interval.group(1)+';\n'+'\n'.join(b[:b.index('{')].strip()+';' for b in blocks)+'\n'+'\n'.join(blocks)
 (folder/'native_account_wire.inc').write_text(wire)
 binary=folder/'check';cmd=[compiler,'-std=c++17','-O0','-Wall','-Wextra','-Werror','-Wno-unused-parameter','-I',str(folder),str(root/'tests/native_account_report_test.cpp'),'-o',str(binary)]
 if platform.system()!='Darwin':cmd+=['-lcrypto']
 subprocess.run(cmd,check=True);result=subprocess.run([str(binary)],capture_output=True,text=True)
 print(result.stderr.strip())
 if result.returncode:print(result.stdout);raise SystemExit(result.returncode)
 rows=[json.loads(line) for line in result.stdout.splitlines()]
 for row in rows:
  if row.get('crossLanguage'):
   report=row['envelope']['payload'];assert report['accountBinding']==hashlib.sha256(b'ARX_ACCOUNT_V1\n12345678\nFixture server').hexdigest();assert report['currency']=='KWD' and report['currencyDigits']==3;continue
  payload=row['payload'];digits=row['digits']
  assert payload['accountBinding']==hashlib.sha256(('ARX_ACCOUNT_V1\n123456789\nBroker-é').encode()).hexdigest()
  assert payload['currencyDigits']==digits and payload['observedAtEpochMs']==1800000000000
  assert re.fullmatch('[a-f0-9]{64}',payload['producerInstanceId'])
  for field in ['balance','equity','profit','credit','margin','freeMargin']:
   assert isinstance(payload[field],str) and len(payload[field])<=48
   assert re.fullmatch(r'-?(?:0|[1-9][0-9]*)(?:\.[0-9]{'+str(digits)+'})?' if digits else r'-?(?:0|[1-9][0-9]*)',payload[field])
  for field,expected in zip(['balance','equity','profit','credit','margin','freeMargin'],[1000.125,1055.375,12.345,43.03,10.0,-2.125]):
   assert payload[field]==format(expected,'.'+str(digits)+'f'),(field,digits,payload[field])
  assert float(payload['profit']) != float(payload['equity'])-float(payload['balance'])
 if args.emit_file:Path(args.emit_file).write_text(json.dumps(rows,indent=2)+'\n')
 print(str(len(rows))+' Python-verified payload precision/hash fixtures pass')
