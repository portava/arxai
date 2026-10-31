import os,subprocess,json,pathlib,datetime
root=pathlib.Path('/Users/areyouok/arx-chart-resize-dedup-20261031');out=pathlib.Path('/Users/areyouok/arx-tier1-release/chart-resize-dedup-20261031')
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
env=os.environ.copy();env.update(NODE_PATH='/Users/areyouok/arx-tier1-release/chart-workspace-tools-final-20261028/reload-runtime:/Users/areyouok/arxai/node_modules/.pnpm/rollup@4.59.0/node_modules:/Users/areyouok/arxai/node_modules/.pnpm/@tailwindcss+oxide@4.2.1/node_modules', ESBUILD_BINARY_PATH='/Users/areyouok/arxai/node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/lib/downloaded-@esbuild-darwin-arm64-esbuild',NODE_OPTIONS='--max-old-space-size=8192',PORT='4180',BASE_PATH='/',DATABASE_URL='postgres://offline@127.0.0.1:1/none')
checks=[('frontend',['/Users/areyouok/.local/bin/pnpm','--filter','@workspace/trading-dashboard','test'],root),('typecheck',['/Users/areyouok/.local/bin/pnpm','--filter','@workspace/trading-dashboard','typecheck'],root),('build',['/Users/areyouok/.local/bin/pnpm','--filter','@workspace/trading-dashboard','build','--configLoader','runner'],root),('guards',['node','--import','tsx','./src/ci/run-all.ts'],root/'scripts'),('bindings',['node','--import','tsx','./src/ci/check-master-live-bridge-binding.test.ts'],root/'scripts')]
r={'head':head,'started':datetime.datetime.now(datetime.timezone.utc).isoformat(),'results':[]}
for name,cmd,cwd in checks:
 log=out/(head[:8]+'-'+name+'.log')
 with log.open('w') as f: result=subprocess.run(cmd,cwd=cwd,env=env,stdout=f,stderr=subprocess.STDOUT)
 r['results'].append({'check':name,'exit':result.returncode,'log':str(log)})
 (out/(head[:8]+'-checks.json')).write_text(json.dumps(r,indent=2)+'\n')
 print(name,result.returncode,flush=True)
r['finished']=datetime.datetime.now(datetime.timezone.utc).isoformat();(out/(head[:8]+'-checks.json')).write_text(json.dumps(r,indent=2)+'\n')
