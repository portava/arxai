import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChartPaneScaleHandle } from './ChartPaneScaleHandle';
import { DEFAULT_PREFERENCES, validatePreferences } from '@/lib/chart-engine/chartWorkspace';
import type { ChartEngineAdapter } from '@/lib/chart-engine/types';

beforeEach(()=>{vi.stubGlobal('PointerEvent',MouseEvent);Object.defineProperty(HTMLElement.prototype,'setPointerCapture',{configurable:true,value:vi.fn()});Object.defineProperty(HTMLElement.prototype,'releasePointerCapture',{configurable:true,value:vi.fn()});});
afterEach(()=>{cleanup();delete (HTMLElement.prototype as any).setPointerCapture;delete (HTMLElement.prototype as any).releasePointerCapture;vi.restoreAllMocks();vi.unstubAllGlobals();});
function setup(){
 const preferences={...DEFAULT_PREFERENCES,studies:[{id:'rsi',kind:'rsi' as const,period:14,color:'#ffffff',paneScale:{mode:'line' as const,value:50,percent:50}}]};
 const result={contextKey:'source-one',studiesKey:JSON.stringify(validatePreferences(preferences).studies),id:'rsi',scale:{mode:'line' as const,value:50,percent:25}};
 const adapter={beginStudyPaneScale:vi.fn(()=>1),previewStudyPaneScale:vi.fn(()=>true),endStudyPaneScale:vi.fn((_token:number,commit:boolean)=>commit?result:null),isStudyPaneScaleContextCurrent:vi.fn(()=>true)};
 const onPreferences=vi.fn(),pane={id:'rsi',paneIndex:1,label:'RSI',collapsed:false,scaleAnchor:{value:50,percent:50,y:250},left:8,top:200,width:700,height:100};
 const props={adapter:adapter as unknown as ChartEngineAdapter,pane,onPreferences};const view=render(<ChartPaneScaleHandle {...props}/>);
 return {adapter,onPreferences,preferences,view,props,handle:screen.getByRole('slider')};
}
it('previews pointer movement without saving and persists once on release',()=>{
 const f=setup();fireEvent.pointerDown(f.handle,{button:0,clientY:200});fireEvent.pointerMove(f.handle,{clientY:240});
 expect(f.adapter.previewStudyPaneScale).toHaveBeenCalledWith(1,40);expect(f.onPreferences).not.toHaveBeenCalled();
 fireEvent.pointerUp(f.handle,{clientY:245});expect(f.adapter.previewStudyPaneScale).toHaveBeenLastCalledWith(1,45);expect(f.onPreferences).toHaveBeenCalledTimes(1);
 expect(f.onPreferences.mock.calls[0]![0](f.preferences).studies[0].paneScale).toEqual({mode:'line',value:50,percent:25});
});
it.each(['Escape','cancel','lost','blur','unmount'])('cancels %s without writing preferences',kind=>{
 const f=setup();fireEvent.pointerDown(f.handle,{button:0,clientY:200});fireEvent.pointerMove(f.handle,{clientY:240});
 if(kind==='Escape')fireEvent.keyDown(f.handle,{key:kind});else if(kind==='cancel')fireEvent.pointerCancel(f.handle);else if(kind==='lost')fireEvent.lostPointerCapture(f.handle);else if(kind==='blur')fireEvent(window,new Event('blur'));else f.view.unmount();
 expect(f.adapter.endStudyPaneScale).toHaveBeenCalledWith(1,false);expect(f.onPreferences).not.toHaveBeenCalled();
});
it('supports keyboard anchor movement without invoking chart shortcuts',()=>{
 const f=setup();fireEvent.keyDown(f.handle,{key:'ArrowDown'});expect(f.adapter.previewStudyPaneScale).toHaveBeenLastCalledWith(1,1);
 fireEvent.keyDown(f.handle,{key:'ArrowUp',shiftKey:true});expect(f.adapter.previewStudyPaneScale).toHaveBeenLastCalledWith(1,-.1);expect(f.onPreferences).toHaveBeenCalledTimes(2);
});
it('rejects a queued commit after context replacement or edited studies',()=>{
 const f=setup();fireEvent.keyDown(f.handle,{key:'ArrowDown'});const update=f.onPreferences.mock.calls[0]![0];
 const changed={...f.preferences,studies:[{...f.preferences.studies[0]!,period:21}]};expect(update(changed)).toBe(changed);
 f.adapter.isStudyPaneScaleContextCurrent.mockReturnValue(false);expect(update(f.preferences)).toBe(f.preferences);
 f.adapter.isStudyPaneScaleContextCurrent.mockReturnValue(true);f.view.unmount();expect(update(f.preferences)).toBe(f.preferences);
});

it('announces the anchored value and position for keyboard users',()=>{
 const f=setup();expect(f.handle.getAttribute('aria-valuetext')).toContain('Value 50 at 50% from bottom');expect(f.handle.getAttribute('aria-valuemin')).toBe('0');expect(f.handle.getAttribute('aria-valuemax')).toBe('100');
 f.view.rerender(<ChartPaneScaleHandle {...f.props} pane={{...f.props.pane,height:120,scaleAnchor:{value:50,percent:40,y:272}}}/>);expect(f.handle.getAttribute('aria-valuenow')).toBe('40');expect(f.handle.getAttribute('aria-valuetext')).toContain('40% from bottom');
});
