import {it,expect} from 'vitest';
import {validatePreferences} from './chartWorkspace';
import {captureTemplateSettings,applyTemplateSettings,parseTemplateSettings} from './chartTemplates';
const study={kind:'sma' as const,id:'a',period:14,color:'#abcdef',showInStatusLine:true,showOnScale:true};
it('persists independent global switches without overwriting any study',()=>{
 for(const status of [true,false])for(const scale of [true,false]){
  const input={style:'candles',scale:'linear',showStudyStatusValues:status,showStudyScaleLabels:scale,studies:[study]};
  expect(validatePreferences(input)).toEqual(input);
 }
 const original=validatePreferences({studies:[study]});expect(original.showStudyStatusValues).toBeUndefined();expect(original.showStudyScaleLabels).toBeUndefined();
 for(const bad of ['false',0,null,[]]){const clean=validatePreferences({studies:[study],showStudyStatusValues:bad,showStudyScaleLabels:bad});expect(clean.studies).toEqual([study]);expect(clean.showStudyStatusValues).toBeUndefined();expect(clean.showStudyScaleLabels).toBeUndefined();}
});
it('templates preserve readout overrides and reject malformed imported switches',()=>{
 const p=validatePreferences({studies:[study],showStudyStatusValues:false,showStudyScaleLabels:false});
 const template=captureTemplateSettings(p);expect(template).toEqual(p);
 expect(applyTemplateSettings(validatePreferences({}),template)).toEqual(p);
 expect(parseTemplateSettings({...template,showStudyStatusValues:'false'})).toBeNull();
 expect(parseTemplateSettings({...template,showStudyScaleLabels:0})).toBeNull();
});
