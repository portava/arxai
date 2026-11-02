import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChartWorkbenchTools } from './ChartWorkbenchTools';
import { DEFAULT_PREFERENCES } from '@/lib/chart-engine/chartWorkspace';
import type { ChartEngineAdapter } from '@/lib/chart-engine';

class Observer {
  static instances: Observer[] = [];
  target: Element | null = null;
  disconnect = vi.fn();
  constructor(readonly callback: ResizeObserverCallback) { Observer.instances.push(this); }
  observe(target: Element) { this.target = target; }
  deliver(width: number) { act(() => this.callback([{ target: this.target, contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver)); }
}
const adapter = {setDrawings:vi.fn(),setDrawingHandler:vi.fn(),setNavigationMode:vi.fn()} as unknown as ChartEngineAdapter;
const props = {adapter,epoch:1,symbol:'EURUSD',timeframe:'M15',preferences:DEFAULT_PREFERENCES,onPreferences:vi.fn(),hasCandles:true,feedLabel:'Offline fixture'};
const mount = () => render(<ChartWorkbenchTools {...props}/>);
const activeObserver = () => Observer.instances.at(-1)!;
beforeEach(() => { localStorage.clear(); Observer.instances=[]; vi.clearAllMocks(); vi.stubGlobal('ResizeObserver',Observer); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('mount does not synchronously force pane style or width; observer content width chooses compact mode', () => {
  const css = vi.spyOn(window,'getComputedStyle');
  const width = vi.spyOn(HTMLElement.prototype,'clientWidth','get');
  const view = mount();
  const root = view.container.querySelector('[data-testid="chart-workbench-tools"]')!;
  // Inspect before accessibility queries, which legitimately consult styles.
  expect(css.mock.calls.some(([element]) => element===root)).toBe(false);
  expect(width.mock.contexts.some(element => element===root)).toBe(false);
  expect(activeObserver().target).toBe(root);
  activeObserver().deliver(390);
  expect(screen.getByTestId('chart-advanced-tools').className).toBe('hidden');
  expect(screen.getByRole('button',{name:'Chart tools'}).className).not.toBe('hidden');
});

it('first wide observation leaves all desktop controls available; hidden/zero width does not change a known pane mode', () => {
  mount(); activeObserver().deliver(900);
  expect(screen.getByTestId('chart-advanced-tools').className).toBe('contents');
  expect(screen.getByRole('button',{name:'Pan',exact:true})).toBeTruthy();
  activeObserver().deliver(390); activeObserver().deliver(0);
  expect(screen.getByTestId('chart-advanced-tools').className).toBe('hidden');
});

it('captures a focused advanced control before compact mode hides it and restores Pan when the toggle disappears', () => {
  mount();activeObserver().deliver(900);
  const drawing=screen.getByLabelText('Drawing tool');drawing.focus();
  activeObserver().deliver(639);
  const toggle=screen.getByRole('button',{name:'Chart tools'});
  expect(document.activeElement).toBe(toggle);
  activeObserver().deliver(640);
  expect(document.activeElement).toBe(screen.getByRole('button',{name:'Pan',exact:true}));
});

it('opening compact tools keeps controls accessible and does not introduce a synchronous geometry read on observer replacement', () => {
  const view=mount();activeObserver().deliver(390);
  const root=view.container.querySelector('[data-testid="chart-workbench-tools"]')!;
  const toggle=screen.getByRole('button',{name:'Chart tools'}),old=activeObserver();
  const css=vi.spyOn(window,'getComputedStyle'),width=vi.spyOn(HTMLElement.prototype,'clientWidth','get');
  fireEvent.click(toggle);
  expect(css.mock.calls.some(([element])=>element===root)).toBe(false);
  expect(width.mock.contexts.some(element=>element===root)).toBe(false);
  expect(old.disconnect).toHaveBeenCalledOnce();
  activeObserver().deliver(390);
  expect(screen.getByTestId('chart-advanced-tools').className).toBe('contents');
  const drawing=screen.getByLabelText('Drawing tool');drawing.focus();
  activeObserver().deliver(800);activeObserver().deliver(390);
  expect(document.activeElement).toBe(drawing);
  expect(screen.getByTestId('chart-advanced-tools').className).toBe('contents');
});

it('pane widths are independent of viewport width and of other chart instances', () => {
  render(<><ChartWorkbenchTools {...props}/><ChartWorkbenchTools {...props} symbol="USDJPY"/></>);
  const [first,second]=Observer.instances;
  first!.deliver(390);second!.deliver(900);
  expect(screen.getAllByTestId('chart-advanced-tools').map(node=>node.className)).toEqual(['hidden','contents']);
  first!.deliver(700);
  expect(screen.getAllByTestId('chart-advanced-tools').map(node=>node.className)).toEqual(['contents','contents']);
});

it('disconnects the pane observer on unmount without any external data request', () => {
  const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const view=mount();const observer=activeObserver();observer.deliver(390);
  view.unmount();expect(observer.disconnect).toHaveBeenCalledOnce();expect(fetch).not.toHaveBeenCalled();
});
