import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { ScannerSecondaryPanels } from './ScannerSecondaryPanels';
import { PageTabs } from '@/components/ui/PageTabs';
const transitions = vi.hoisted(() => ({ deferred: false, queued: [] as Array<() => void> }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, startTransition: (callback: () => void) => transitions.deferred ? transitions.queued.push(callback) : actual.startTransition(callback) };
});
let next: number, frames: Map<number, FrameRequestCallback>, retired: FrameRequestCallback[];
beforeEach(() => {
  vi.useFakeTimers(); next = 1; frames = new Map(); retired = [];
  transitions.deferred = false; transitions.queued = []; localStorage.clear();
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { const id = next++; frames.set(id, fn); retired.push(fn); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
function frame() { const pending = [...frames.values()]; frames.clear(); act(() => pending.forEach(fn => fn(1))); }
describe('secondary Scanner mounting', () => {
  it('does not mount the panel or its effects before two frames', () => {
    const mounted = vi.fn(); function Panel() { useEffect(mounted, []); return <p>Current panel</p>; }
    render(<ScannerSecondaryPanels><Panel /></ScannerSecondaryPanels>);
    expect(screen.getByRole('status').textContent).toContain('Loading'); expect(mounted).not.toHaveBeenCalled();
    frame(); expect(mounted).not.toHaveBeenCalled(); frame(); expect(mounted).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Current panel')).toBeTruthy(); expect(screen.queryByRole('status')).toBeNull();
  });
  it('allows direct user intent to reveal without waiting', () => {
    render(<ScannerSecondaryPanels><p>Current panel</p></ScannerSecondaryPanels>);
    fireEvent.click(screen.getByRole('button', { name: 'Show scanner panels now' }));
    expect(screen.getByText('Current panel')).toBeTruthy(); expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('falls back when rendering callbacks are suspended', () => {
    render(<ScannerSecondaryPanels><p>Current panel</p></ScannerSecondaryPanels>);
    act(() => vi.advanceTimersByTime(250)); expect(screen.getByText('Current panel')).toBeTruthy(); expect(frames.size).toBe(0);
  });
  it('renders the latest context and retains mounted panel state', () => {
    function Panel({ symbol }: { symbol: string }) { const [value, set] = useState(''); return <label>{symbol}<input value={value} onChange={e => set(e.target.value)} /></label>; }
    const view = render(<ScannerSecondaryPanels><Panel symbol="EURUSD" /></ScannerSecondaryPanels>);
    view.rerender(<ScannerSecondaryPanels><Panel symbol="USDJPY" /></ScannerSecondaryPanels>); frame(); frame();
    const input = screen.getByRole('textbox'); expect(screen.queryByText('EURUSD')).toBeNull();
    fireEvent.change(input, { target: { value: 'retained draft' } });
    view.rerender(<ScannerSecondaryPanels><Panel symbol="GBPUSD" /></ScannerSecondaryPanels>);
    expect(screen.getByRole('textbox')).toBe(input); expect((input as HTMLInputElement).value).toBe('retained draft');
  });
  it('cancels work and ignores already-queued callbacks after unmount', () => {
    const mounted = vi.fn(); function Panel() { useEffect(mounted, []); return <p>Panel</p>; }
    const view = render(<ScannerSecondaryPanels><Panel /></ScannerSecondaryPanels>); frame(); view.unmount();
    expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    act(() => retired.forEach(fn => fn(1))); expect(mounted).not.toHaveBeenCalled(); expect(frames.size).toBe(0);
  });
  it('preserves keyboard focus when the focused loading button is replaced', () => {
    render(<ScannerSecondaryPanels><button role="tab" aria-selected="true">Focus panel</button></ScannerSecondaryPanels>);
    const reveal = screen.getByRole('button', { name: 'Show scanner panels now' }); reveal.focus(); frame(); frame();
    expect(document.activeElement).toBe(screen.getByRole('tab'));
  });
  it('focuses the saved active tab rather than changing the selection', () => {
    localStorage.setItem('arx.pageTab.test-secondary', 'broad');
    render(<ScannerSecondaryPanels><PageTabs storageKey="test-secondary" tabs={[{ id: 'focus', label: 'Focus', content: 'Focus content' }, { id: 'broad', label: 'Broad Scan', content: 'Broad content' }]} /></ScannerSecondaryPanels>);
    screen.getByRole('button', { name: 'Show scanner panels now' }).focus(); frame(); frame();
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Broad Scan' }));
    expect(screen.getByRole('tab', { name: 'Broad Scan' }).getAttribute('aria-selected')).toBe('true');
  });
  it('an explicit reveal supersedes a queued automatic transition', () => {
    transitions.deferred = true;
    render(<ScannerSecondaryPanels><p>Current panel</p></ScannerSecondaryPanels>); frame(); frame();
    expect(screen.queryByText('Current panel')).toBeNull(); expect(transitions.queued).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show scanner panels now' }));
    expect(screen.getByText('Current panel')).toBeTruthy();
  });
  it('does not steal focus if the user leaves while an automatic transition is pending', () => {
    transitions.deferred = true;
    render(<><button>Elsewhere</button><ScannerSecondaryPanels><button role="tab" aria-selected="true">Focus panel</button></ScannerSecondaryPanels></>);
    screen.getByRole('button', { name: 'Show scanner panels now' }).focus(); frame(); frame();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' }); elsewhere.focus();
    act(() => transitions.queued.forEach(callback => callback())); expect(document.activeElement).toBe(elsewhere);
  });
});
