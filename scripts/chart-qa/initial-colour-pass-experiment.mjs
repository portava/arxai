// QA only. Skip a redundant colour pass after all built-in rows have just been
// freshly coloured. Standalone option changes and Custom series retain the original path.
import {createHash} from 'node:crypto';
export const expectedSha256='8f941c04ad6eae2970b21a50be54c5f23778e18c1dfcddaf66574dd8ed2e0945';
const hash=s=>createHash('sha256').update(s).digest('hex');
export function transformInitialColourPass(source){
 if(hash(source)!==expectedSha256)throw Error('Requires exact lightweight-charts 5.2.0 production module');
 const before='this.Mg&&(this.Dg(),this.Mg=!1),this.gg&&(this.Tg(),this.gg=!1)';
 const after='this.Mg&&(this.Dg(),this.Mg=!1,"Custom"!==this.ae.bh()&&(this.gg=!1)),this.gg&&(this.Tg(),this.gg=!1)';
 if(source.split(before).length!==2)throw Error('Initial colour pass seam changed');
 return source.replace(before,after);
}
export function initialColourPassExperiment(){
 let receipt=null;
 return{plugin:{name:'arx-qa-only-initial-colour-pass',enforce:'pre',transform(source,id){
  if(!id.endsWith('/lightweight-charts.production.mjs'))return null;
  if(receipt)throw Error('Multiple chart dependency transforms');
  const code=transformInitialColourPass(source);receipt={qaOnly:true,dependency:'lightweight-charts@5.2.0',inputSha256:expectedSha256,outputSha256:hash(code),changes:'Skip duplicate built-in colour pass only after fresh raw items; options-only and Custom unchanged'};
  return{code,map:null};
 },buildEnd(error){if(!error&&!receipt)throw Error('Experiment did not transform production dependency');}},receipt(){if(!receipt)throw Error('No experiment receipt');return receipt;}};
}
