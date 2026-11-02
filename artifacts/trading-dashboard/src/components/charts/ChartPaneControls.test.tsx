import { flushSync } from 'react-dom';
import { Profiler, startTransition, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChartPaneControls } from './ChartPaneControls';
import { DEFAULT_PREFERENCES, type ChartPreferences } from '@/lib/chart-engine/chartWorkspace';
import type { ChartEngineAdapter, ChartStudyPaneControl } from '@/lib/chart-engine/types';

afterEach(()=>{cleanup();document.body.replaceChildren();});
function setup(){
  const target=document.createElement('div');document.body.append(target);
  let panes:ChartStudyPaneControl[]=[{id:'rsi',paneIndex:1,label:'RSI (14)',collapsed:false,left:0,top:200,width:700,height:100}];
  let notify=()=>{};
  const unsubscribe=vi.fn();
  const adapter={getStudyPaneControls:()=>panes,subscribeViewport:(fn:()=>void)=>{notify=fn;return unsubscribe;}} as ChartEngineAdapter;
  const preferences:ChartPreferences={...DEFAULT_PREFERENCES,studies:[{id:'rsi',kind:'rsi',period:14,color:'#ffffff'},{id:'sma',kind:'sma',period:20,color:'#00ff00'}]};
  return {target,adapter,preferences,unsubscribe,chartTarget:{current:target},emit:(value=panes)=>{panes=value;act(()=>notify());},set:(value:ChartStudyPaneControl[])=>{panes=value;},retained:()=>notify};
}
it('positions an accessible control on its pane and preserves unrelated preferences and studies',()=>{
  const f=setup();
  function Workspace(){const [preferences,onPreferences]=useState(f.preferences);return <><ChartPaneControls adapter={f.adapter} chartTarget={f.chartTarget} enabled onPreferences={onPreferences}/><output>{JSON.stringify(preferences)}</output></>;}
  render(<Workspace/>);const button=screen.getByRole('button',{name:'Collapse pane 1: RSI (14)'});
  expect(f.target.contains(button)).toBe(true);expect(button.style.left).toBe('672px');expect(button.style.top).toBe('200px');
  fireEvent.click(button);const current=JSON.parse(screen.getByRole('status').textContent!);
  expect(current).toEqual({...f.preferences,studies:[{...f.preferences.studies[0],paneCollapsed:true},f.preferences.studies[1]]});
  f.emit([{...f.adapter.getStudyPaneControls!()![0]!,collapsed:true,height:24}]);
  const expand=screen.getByRole('button',{name:'Expand pane 1: RSI (14)'});expect(expand).toBe(button);expect(expand.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(expand);expect(JSON.parse(screen.getByRole('status').textContent!).studies[0].paneCollapsed).toBe(false);
});
it('does not start chart gestures or keyboard shortcuts and lets Escape/Tab propagate',()=>{
  const f=setup(),pointer=vi.fn(),key=vi.fn(),click=vi.fn();
  render(<div onPointerDown={pointer} onKeyDown={key} onClick={click}><ChartPaneControls adapter={f.adapter} chartTarget={f.chartTarget} enabled onPreferences={vi.fn()}/></div>);
  const button=screen.getByRole('button');fireEvent.pointerDown(button);fireEvent.click(button);fireEvent.keyDown(button,{key:'Delete'});
  expect(pointer).not.toHaveBeenCalled();expect(click).not.toHaveBeenCalled();expect(key).not.toHaveBeenCalled();
  fireEvent.keyDown(button,{key:'Escape'});fireEvent.keyDown(button,{key:'Tab'});expect(key).toHaveBeenCalledTimes(2);
});
it('rejects a stale rendered pane and a queued updater after the chart context is replaced',()=>{
  const f=setup(),onPreferences=vi.fn();
  const view=render(<ChartPaneControls key="first" adapter={f.adapter} chartTarget={f.chartTarget} enabled onPreferences={onPreferences}/>);
  const button=screen.getByRole('button');const original=f.adapter.getStudyPaneControls!()!;f.set([]);fireEvent.click(button);expect(onPreferences).not.toHaveBeenCalled();
  f.set(original);fireEvent.click(button);expect(onPreferences).toHaveBeenCalledTimes(1);
  const update=onPreferences.mock.calls[0]![0],oldNotify=f.retained();
  view.rerender(<ChartPaneControls key="second" adapter={f.adapter} chartTarget={f.chartTarget} enabled onPreferences={onPreferences}/>);
  expect(update(f.preferences)).toBe(f.preferences);act(()=>oldNotify());expect(screen.getAllByRole('button')).toHaveLength(1);expect(f.unsubscribe).toHaveBeenCalledTimes(1);
});
it('does not let an old control overwrite a changed owner or an unrelated price overlay',()=>{
  const f=setup(),onPreferences=vi.fn();render(<ChartPaneControls adapter={f.adapter} chartTarget={f.chartTarget} enabled onPreferences={onPreferences}/>);
  fireEvent.click(screen.getByRole('button'));const update=onPreferences.mock.calls[0]![0];
  for(const studies of [[],[{...f.preferences.studies[0]!,paneCollapsed:true}],[{...f.preferences.studies[1]!,id:'rsi'}]]){
    const current={...f.preferences,studies};expect(update(current)).toBe(current);
  }
});
it('withdraws controls while disabled or unpainted and ignores retained callbacks after cleanup',()=>{
  const f=setup(),props={adapter:f.adapter,chartTarget:f.chartTarget,onPreferences:vi.fn()};
  const view=render(<ChartPaneControls {...props} enabled/>);expect(screen.getAllByRole('button')).toHaveLength(1);
  f.emit([]);expect(screen.queryByRole('button')).toBeNull();
  view.rerender(<ChartPaneControls {...props} enabled={false}/>);expect(screen.queryByRole('button')).toBeNull();
  const old=f.retained();view.unmount();act(()=>old());expect(f.unsubscribe).toHaveBeenCalledTimes(1);expect(f.target.childElementCount).toBe(0);
});
it('does not subscribe when the adapter has no pane capability',()=>{
  const f=setup(),subscribe=vi.fn();render(<ChartPaneControls adapter={{subscribeViewport:subscribe} as ChartEngineAdapter} chartTarget={f.chartTarget} enabled onPreferences={vi.fn()}/>);
  expect(subscribe).not.toHaveBeenCalled();expect(screen.queryByRole('button')).toBeNull();
});

it('unchanged viewport geometry causes no React commit and real resize updates the control',()=>{
  const f=setup(),commits=vi.fn();render(<Profiler id="pane" onRender={commits}><ChartPaneControls adapter={f.adapter} chartTarget={f.chartTarget} enabled onPreferences={vi.fn()}/></Profiler>);
  commits.mockClear();for(let i=0;i<20;i++)f.emit(f.adapter.getStudyPaneControls!()!.map(p=>({...p})));
  expect(commits).not.toHaveBeenCalled();f.emit([{...f.adapter.getStudyPaneControls!()![0]!,width:500}]);
  expect(commits).toHaveBeenCalledTimes(1);expect(screen.getByRole('button').style.left).toBe('472px');
});

it('adapter replacement cannot lose a geometry update queued by the previous adapter',()=>{
  const f=setup(),geometry=f.adapter.getStudyPaneControls!()!,onPreferences=vi.fn();f.set([]);
  const view=render(<ChartPaneControls adapter={f.adapter} chartTarget={f.chartTarget} enabled onPreferences={onPreferences}/>);
  const next={getStudyPaneControls:()=>geometry,subscribeViewport:()=>()=>{}} as ChartEngineAdapter;
  act(()=>{
    f.set(geometry);startTransition(()=>f.retained()());
    flushSync(()=>view.rerender(<ChartPaneControls adapter={next} chartTarget={f.chartTarget} enabled onPreferences={onPreferences}/>));
  });
  expect(screen.getByRole('button',{name:'Collapse pane 1: RSI (14)'})).toBeTruthy();
});

it('pending paint retains the button but cannot grant action authority',()=>{
  const f=setup(),onPreferences=vi.fn(),read=vi.fn<()=>ChartStudyPaneControl[]|null>(()=>f.adapter.getStudyPaneControls!()!);
  const engine={...f.adapter,getStudyPaneControls:read};render(<ChartPaneControls adapter={engine} chartTarget={f.chartTarget} enabled onPreferences={onPreferences}/>);
  const button=screen.getByRole('button');button.focus();read.mockReturnValue(null);f.emit();fireEvent.click(button);
  expect(document.activeElement).toBe(button);expect(onPreferences).not.toHaveBeenCalled();
});
it('maximizes and restores the painted owner without writing preferences or losing its button',()=>{
 const f=setup(),save=vi.fn(),maximize=vi.fn((id:string|null)=>{f.emit([{...f.adapter.getStudyPaneControls!()![0]!,maximized:id!==null}]);return true;});f.adapter.setMaximizedStudyPane=maximize;
 render(<ChartPaneControls adapter={f.adapter} chartTarget={f.chartTarget} enabled onPreferences={save}/>);
 const button=screen.getByRole('button',{name:'Maximize pane 1: RSI (14)'});button.focus();fireEvent.click(button);
 expect(maximize).toHaveBeenLastCalledWith('rsi');expect(document.activeElement).toBe(button);expect(screen.getByRole('button',{name:'Collapse pane 1: RSI (14)'}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Restore layout from pane 1: RSI (14)'}));expect(maximize).toHaveBeenLastCalledWith(null);expect(save).not.toHaveBeenCalled();
 f.set([]);fireEvent.click(button);expect(maximize).toHaveBeenCalledTimes(2);
});
