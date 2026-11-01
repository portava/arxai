// QA-only, isolated Line/Area/Baseline/Histogram experiment. The application build
// does not import this file, and installed dependency bytes are never changed.
import { createHash } from 'node:crypto';
export const expectedSha256 = '8f941c04ad6eae2970b21a50be54c5f23778e18c1dfcddaf66574dd8ed2e0945';
const sha256 = text => createHash('sha256').update(text).digest('hex');
export function transformStudyRows(source) {
  if (sha256(source) !== expectedSha256) throw Error('Study-row experiment requires the exact lightweight-charts 5.2.0 production module');
  const before = 'Dg(){const t=this.ae.Sa();this.bg=this.ae.Ha().Bh().map((i=>{let n;if((i.Zr??1)>1){const t=i.Wt[1],s=i.Wt[2],e=i.Wt[3];n=Math.abs(t-e)>Math.abs(s-e)?t:s}else n=i.Wt[3];return this.xb(i.$n,n,t)}))}';
  const after = 'Dg(){const t=this.ae.Sa(),r=this.ae.Ha(),s=r===this.ae.Un();this.bg=r.Bh().map((i=>{let n;if((i.Zr??1)>1){const t=i.Wt[1],s=i.Wt[2],e=i.Wt[3];n=Math.abs(t-e)>Math.abs(s-e)?t:s}else n=i.Wt[3];return this.xb(i.$n,n,t,s?{Wt:i}:void 0)}))}';
  if (source.split(before).length !== 2) throw Error('Line-base row-builder seam changed');
  source = source.replace(before, after);
  const itemBefore = 'xb(t,i,n){return{...this.Sb(t,i),...n.Sh(t)}}';
  const itemAfter = 'xb(t,i,n,s){return{...this.Sb(t,i),...n.Sh(t,s)}}';
  if (source.split(itemBefore).length !== 5) throw Error('Expected precisely four line-family item builders');
  return source.replaceAll(itemBefore, itemAfter);
}
export function studyRowReuseExperiment() {
  let receipt = null;
  return {
    plugin: {
      name: 'arx-qa-only-study-row-reuse', enforce: 'pre',
      transform(source, id) {
        if (!id.endsWith('/lightweight-charts.production.mjs')) return null;
        if (receipt) throw Error('Unexpected multiple chart dependency transforms');
        const code = transformStudyRows(source);
        receipt = { qaOnly: true, dependency: 'lightweight-charts@5.2.0', inputSha256: expectedSha256, outputSha256: sha256(code), conflatedRows: 'original lookup preserved', changes: 'Line/Area/Baseline/Histogram only; OHLC and custom unchanged' };
        return { code, map: null };
      },
      buildEnd(error) { if (!error && !receipt) throw Error('Experiment did not transform the production chart dependency'); },
    },
    receipt() { if (!receipt) throw Error('Missing study-row experiment receipt'); return receipt; },
  };
}
