// Build only: node scripts/scanner-qa/shared-chart-fixture/build.mjs
// Serve the returned build: node .../build.mjs --serve=<build-id>
// Uses actual dashboard entry/components, with a fixture-only adapter observer.
// It never writes dashboard dist, calls an API, or starts a trading process.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

process.env.NODE_ENV = 'production';
const root = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(root, '../../..');
const dashboard = path.join(repo, 'artifacts/trading-dashboard');
const require = createRequire(path.join(dashboard, 'package.json'));
const sha = data => createHash('sha256').update(data).digest('hex');
const git = args => execFileSync('git', args, {cwd:repo, encoding:'utf8'}).trim();
const state = () => ({head:git(['rev-parse','HEAD']), status:git(['status','--porcelain','--untracked-files=all']), diffSha256:sha(git(['diff','HEAD','--']))});
const args = process.argv.slice(2);
if (args.length > 1 || (args[0] && !/^--serve=[a-f0-9]{16}$/.test(args[0]))) throw Error('Only --serve=<build-id> is supported');
const serve = args[0]?.slice(8);
const id = serve ?? randomBytes(8).toString('hex');
const parent = path.join(repo, 'scripts/node_modules/.scanner-shared-chart-qa');
const out = path.join(parent, id);
const metadataFile = 'arx-scanner-qa-build-info.json';
const filesUnder = async dir => {
  const files = [];
  for (const entry of await readdir(dir, {withFileTypes:true})) {
    const absolute = path.join(dir,entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(absolute));
    else if (entry.isFile()) files.push(absolute);
    else throw Error('Unexpected non-regular build entry: '+absolute);
  }
  return files;
};
if (!serve) {
  const before = state();
  await mkdir(parent,{recursive:true});
  await mkdir(out); // New directory only; never empty or overwrite another build.
  const {build} = await import(require.resolve('vite'));
  const {default:react} = await import(require.resolve('@vitejs/plugin-react'));
  const {default:tailwind} = await import(require.resolve('@tailwindcss/vite'));
  await build({root,configFile:false,base:'/',define:{__ARX_SCANNER_QA_BUILD_ID__:JSON.stringify(id)},plugins:[react(),tailwind()],resolve:{alias:[
    {find:'react',replacement:path.dirname(require.resolve('react/package.json'))},
    {find:'react-dom',replacement:path.dirname(require.resolve('react-dom/package.json'))},
    {find:'@',replacement:path.join(dashboard,'src')},
    {find:'@assets',replacement:path.join(repo,'attached_assets')},
  ],dedupe:['react','react-dom']},build:{outDir:out,emptyOutDir:false,minify:'esbuild',sourcemap:false}});
  const after = state();
  const entries = await filesUnder(out);
  const hashes = Object.fromEntries(await Promise.all(entries.map(async file => [path.relative(out,file),sha(await readFile(file))])));
  const sources = await Promise.all(entries.filter(f=>f.endsWith('.js')).map(f=>readFile(f,'utf8')));
  const dev = ['react-stack-bottom-frame','data must be asc ordered by time','series item data value must be'];
  if (dev.some(marker=>sources.some(s=>s.includes(marker)))) throw Error('Development runtime found');
  if (!['Minified React error #','tv-lightweight-charts'].every(marker=>sources.some(s=>s.includes(marker)))) throw Error('Expected production runtime not found');
  const metadata = {schemaVersion:1,buildId:id,builtAt:new Date().toISOString(),source:before,sourceUnchanged:JSON.stringify(before)===JSON.stringify(after),minified:true,productionRuntimeChecked:true,
    entry:'Actual dashboard src/main.tsx; observer installed before mount',fixtureOnlyObserver:'scripts/chart-qa/witness.ts',hashes,
    limitations:['Isolated Vite configuration; this is not the deployable dashboard bundle.','Offline synthetic data and unavailable reader truth; no production or broker validation.','No hardware paint or competitor performance measurement.']};
  await writeFile(path.join(out,metadataFile),JSON.stringify(metadata,null,2)+'\n');
  console.log(JSON.stringify({buildId:id,out,source:before,sourceUnchanged:metadata.sourceUnchanged,serve:`node scripts/scanner-qa/shared-chart-fixture/build.mjs --serve=${id}`},null,2));
} else {
  const info = JSON.parse(await readFile(path.join(out,metadataFile),'utf8'));
  if(info.buildId!==id || info.schemaVersion!==1) throw Error('Wrong build metadata');
  for (const [relative,expected] of Object.entries(info.hashes)) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw Error('Invalid manifest path');
    if(sha(await readFile(path.join(out,relative)))!==expected) throw Error('Asset changed: '+relative);
  }
  const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
  const server=http.createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://127.0.0.1:4199').pathname;
    if(req.method!=='GET' || pathname.startsWith('/api/')) {res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"OFFLINE_API_NOT_INTERCEPTED"}');return;}
    const relative=pathname===`/${metadataFile}`?metadataFile:(pathname==='/'||pathname==='/market-scanner'?'index.html':pathname.slice(1));
    if(relative!==metadataFile && !(relative in info.hashes)){res.writeHead(404);res.end();return;}
    try {const data=await readFile(path.join(out,relative));res.writeHead(200,{'content-type':relative===metadataFile?'application/json':types[path.extname(relative)]??'application/octet-stream','cache-control':'no-store'});res.end(data);}
    catch {res.writeHead(500);res.end();}
  });
  server.listen(4199,'127.0.0.1',()=>console.log('Actual Scanner offline QA on http://127.0.0.1:4199; build '+id));
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close(()=>process.exit(0)));
}
