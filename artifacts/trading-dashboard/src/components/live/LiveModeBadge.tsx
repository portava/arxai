import {Lock,Shield,AlertTriangle} from 'lucide-react';
import {cn} from '@/lib/utils';
import {useAccountModePresentation} from '@/hooks/useAccountModePresentation';
const BASE=(import.meta.env.BASE_URL||'/').replace(/\/$/,'');
/** Account selection and reported restriction, never chart/feed connectivity. */
export function LiveModeBadge({compact=false}:{compact?:boolean}){
 const state=useAccountModePresentation();
 const Icon=state.tone==='danger'?Shield:state.tone==='warning'?AlertTriangle:Lock;
 return <a href={`${BASE}${state.href}`} data-testid="live-mode-badge" title={state.detail}
  className={cn('inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-md border px-2 py-1 text-xs font-semibold',
   state.tone==='danger'?'border-rose-500/40 bg-rose-500/15 text-rose-300':state.tone==='warning'?'border-amber-500/40 bg-amber-500/10 text-amber-300':'border-slate-500/30 bg-slate-500/10 text-slate-300')}>
  <Icon className="h-3 w-3" aria-hidden="true"/><span>{compact?state.modeLabel.replace('Account mode:','mode:'):state.modeLabel}</span>
  <span aria-hidden="true">·</span><span>{state.statusLabel}</span>
 </a>;
}
