import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createStockProfileFixture} from './stock-profile-fixture.mjs';
import {acceptStockVolumeProfile,inspectStockProfileNetwork} from './shared-chart-stock-profile-acceptance.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
export const ORIGINAL_STOCK_SHA256='47431eb58f1a539aa84a66461dccd8b95e05cb001186565bfa27c976cb0735df';
const sha=data=>createHash('sha256').update(data).digest('hex');

/** Generates a standalone playwright-cli run-code file from the checked-in
 * shared boundary and journey functions. No browser/network/process is started. */
export async function prepareStockProfileAcceptance({outputDirectory,journey='desktop',origin='http://127.0.0.1:4199'}) {
  if(!path.isAbsolute(outputDirectory)||!['desktop','mobile'].includes(journey))throw Error('Absolute new output directory and desktop|mobile journey required');
  const url=new URL(origin);
  if(url.origin!==origin||url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw Error('Offline fixture requires an explicit HTTP loopback origin');
  const fixtureBytes=await readFile(path.join(root,'fixtures/stock-normalized-20261101.json'));
  if(sha(fixtureBytes)!==ORIGINAL_STOCK_SHA256)throw Error('Original stock fixture changed; do not relabel or silently rebuild its provenance');
  const stock=JSON.parse(fixtureBytes),setup=await readFile(path.join(root,'shared-chart-setup.js'),'utf8');
  createStockProfileFixture(stock); // Validate fixture shape before creating output.
  await mkdir(outputDirectory); // A new run never overwrites an earlier failure.
  const program=`async page => {\nconst stock=${JSON.stringify(stock)};\nconst inspectStockProfileNetwork=${inspectStockProfileNetwork.toString()};\nconst SCANNER_QA_BASE_URL=${JSON.stringify(origin)};\nconst SCANNER_QA_PRESERVE_STORAGE_ON_RELOAD=true;\nconst SCANNER_QA_HOOKS=(${createStockProfileFixture.toString()})(stock);\nawait (${setup.trim()})(page);\nreturn await (${acceptStockVolumeProfile.toString()})(page,{stock,artifactDirectory:${JSON.stringify(outputDirectory)},journey:${JSON.stringify(journey)}});\n}\n`;
  const filename=path.join(outputDirectory,'browser-journey.js');
  await writeFile(filename,program,{flag:'wx'});
  const provenance={schemaVersion:1,journey,origin,filename,fixtureSha256:sha(fixtureBytes),sourceCommit:stock.sourceCommit,setupSha256:sha(setup),programSha256:sha(program),limits:['Synthetic stock provider response through the recorded backend commit, not an observed provider connection.','Original JSON and gap flags preserved byte-for-byte; normalized-response variants are explicitly labelled robustness probes.','All requests use the existing shared offline boundary; API writes, websockets and external origins remain blocked.','Run against a clean frozen actual Scanner fixture, not the isolated performance adapter. No speed or parity claim.']};
  await writeFile(path.join(outputDirectory,'provenance.json'),JSON.stringify(provenance,null,2)+'\n',{flag:'wx'});
  return provenance;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const [outputDirectory,journey='desktop',origin='http://127.0.0.1:4199',...extra]=process.argv.slice(2);
  if(!outputDirectory||extra.length)throw Error('Usage: node scripts/scanner-qa/prepare-stock-profile-acceptance.mjs /absolute/new-run-directory [desktop|mobile] [http://127.0.0.1:4199]');
  console.log(JSON.stringify(await prepareStockProfileAcceptance({outputDirectory,journey,origin}),null,2));
}
