import {AlertTriangle,Lock,Shield} from 'lucide-react';
import {useAccountModePresentation} from '@/hooks/useAccountModePresentation';
import {cn} from '@/lib/utils';
/** Account mode is not an assertion about broker, feed or order health. */
export function EnvironmentPill(){
 const state=useAccountModePresentation();
 const Icon=state.tone==='danger'?Shield:state.tone==='warning'?AlertTriangle:Lock;
 return <div className="flex flex-wrap items-center gap-2.5" data-testid="cockpit-env-pill">
  <span className={cn('inline-flex flex-wrap items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-sm font-semibold',state.tone==='danger'?'text-danger':state.tone==='warning'?'text-warning':'text-txt-secondary')}>
   <Icon className="h-3.5 w-3.5" aria-hidden="true"/><span>{state.modeLabel}</span><span aria-hidden="true">·</span><span>{state.statusLabel}</span>
  </span>
  <span className="text-xs text-txt-secondary">{state.detail}</span>
 </div>;
}
