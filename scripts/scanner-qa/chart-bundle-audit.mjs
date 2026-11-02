// Offline production bundle audit. Usage: node .../chart-bundle-audit.mjs <new-output-directory>
// Builds the actual dashboard config; never serves it or contacts an API.
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const dashboard=path.join(repo,'artifacts/trading-dashboard');
const require=createRequire(path.join(dashboard,'package.json'));
if(process.argv.length!==3)throw Error('Supply one new output directory');
const out=path.resolve(process.argv[2]);
await mkdir(out); // Refuse to overwrite a prior receipt.
const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8'}).trim();
const state=()=>({head:git(['rev-parse','HEAD']),status:git(['status','--porcelain']),diffSha256:createHash('sha256').update(git(['diff','HEAD','--'])).digest('hex')});
const before=state();
process.env.NODE_ENV='production';
process.env.PORT='4180';process.env.BASE_PATH='/';
const {build}=await import(require.resolve('vite'));
let chunks=[];
await build({configFile:path.join(dashboard,'vite.config.ts'),build:{outDir:path.join(out,'public'),emptyOutDir:false},plugins:[{name:'arx-rendered-bundle-audit',generateBundle(_options,bundle){
 chunks=Object.values(bundle).filter(x=>x.type==='chunk').map(x=>({file:x.fileName,isEntry:x.isEntry,isDynamicEntry:x.isDynamicEntry,imports:x.imports,dynamicImports:x.dynamicImports,bytes:Buffer.byteLength(x.code),gzipBytes:gzipSync(x.code).length,sha256:createHash('sha256').update(x.code).digest('hex'),modules:Object.entries(x.modules).filter(([,m])=>m.renderedLength>0).map(([id,m])=>({id:path.isAbsolute(id)?path.relative(repo,id):id,renderedLength:m.renderedLength}))}));
}}]});
const after=state();
const legacyModules=chunks.flatMap(c=>c.modules.filter(m=>/lightweightChartsAdapter\.ts$|(?:^|\/)lightweight-charts(?:\/|@)/.test(m.id)).map(m=>({chunk:c.file,...m})));
const result={schemaVersion:1,before,after,sourceUnchanged:JSON.stringify(before)===JSON.stringify(after),scope:'Actual dashboard production bundle; byte size is not measured load time or competitor parity',totalJsBytes:chunks.reduce((n,c)=>n+c.bytes,0),totalGzipJsBytes:chunks.reduce((n,c)=>n+c.gzipBytes,0),legacyEngineBundled:legacyModules.length>0,legacyModules,chunks};
await writeFile(path.join(out,'report.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({head:before.head,sourceUnchanged:result.sourceUnchanged,totalJsBytes:result.totalJsBytes,totalGzipJsBytes:result.totalGzipJsBytes,legacyEngineBundled:result.legacyEngineBundled,legacyModules}));
if(!result.sourceUnchanged)throw Error('Source changed during bundle audit');
