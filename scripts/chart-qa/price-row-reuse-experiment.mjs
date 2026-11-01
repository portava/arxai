// QA-only experiment. No app build imports this file. Never edits installed packages.
// Keep the dependency's license and notices; the transform only reuses existing OHLC rows.
import { createHash } from 'node:crypto';
export const expectedSha256 = '8f941c04ad6eae2970b21a50be54c5f23778e18c1dfcddaf66574dd8ed2e0945';
const sha256 = text => createHash('sha256').update(text).digest('hex');
export function transformPriceRows(source) {
  if (sha256(source) !== expectedSha256) throw Error('Price-row experiment requires the exact lightweight-charts 5.2.0 production module');
  const before = 'Dg(){const t=this.ae.Sa();this.bg=this.ae.Ha().Bh().map((i=>this.xb(i.$n,i,t)))}';
  const after = 'Dg(){const t=this.ae.Sa(),i=this.ae.Ha(),n=i===this.ae.Un();this.bg=i.Bh().map((i=>this.xb(i.$n,i,t,n)))}';
  if (source.split(before).length !== 2) throw Error('OHLC row-builder seam changed');
  source = source.replace(before, after);
  const itemBefore = 'xb(t,i,n){return{...this.Qb(t,i,n),...n.Sh(t)}}';
  const itemAfter = 'xb(t,i,n,s){return{...this.Qb(t,i,n),...n.Sh(t,s?{Wt:i}:void 0)}}';
  if (source.split(itemBefore).length !== 3) throw Error('Expected precisely Bar and Candlestick item builders');
  return source.replaceAll(itemBefore, itemAfter);
}
export function priceRowReuseExperiment() {
  let receipt = null;
  return {
    plugin: {
      name: 'arx-qa-only-price-row-reuse', enforce: 'pre',
      transform(source, id) {
        if (!id.endsWith('/lightweight-charts.production.mjs')) return null;
        if (receipt) throw Error('Unexpected multiple chart dependency transforms');
        const code = transformPriceRows(source);
        receipt = { qaOnly: true, dependency: 'lightweight-charts@5.2.0', inputSha256: expectedSha256, outputSha256: sha256(code), conflatedRows: 'original lookup preserved', changes: 'Bar and Candlestick raw-row colour lookup only' };
        return { code, map: null };
      },
      buildEnd(error) { if (!error && !receipt) throw Error('Experiment did not transform the production chart dependency'); },
    },
    receipt() { if (!receipt) throw Error('Missing price-row experiment receipt'); return receipt; },
  };
}
