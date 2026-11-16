import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '../../artifacts/trading-dashboard/dist/public');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const files = [...new Set([...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(m => m[1]))];
if (!files.length) throw new Error('No initial JavaScript found; build the dashboard first');
const assets = files.map(url => {
  const path = resolve(root, url.slice(url.indexOf('/assets/') + 1));
  if (!path.startsWith(root + '/assets/')) throw new Error('Unexpected initial asset path');
  const bytes = readFileSync(path);
  return { file: url, bytes: bytes.length, gzipBytes: gzipSync(bytes).length };
});
const bytes = assets.reduce((n, a) => n + a.bytes, 0);
const gzipBytes = assets.reduce((n, a) => n + a.gzipBytes, 0);
const budgets = { initialJsBytes: 720_000, initialJsGzipBytes: 210_000 };
console.log(JSON.stringify({ assets, bytes, gzipBytes, budgets }, null, 2));
if (bytes > budgets.initialJsBytes || gzipBytes > budgets.initialJsGzipBytes) {
  throw new Error('Initial JavaScript performance budget exceeded');
}
