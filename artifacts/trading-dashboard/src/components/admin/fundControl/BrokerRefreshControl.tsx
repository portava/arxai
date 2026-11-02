import {Button} from '@/components/ui/button';
import type {useAdminBrokerMirror} from '@/hooks/useAdminBrokerMirror';
export function BrokerRefreshControl({query}:{query:ReturnType<typeof useAdminBrokerMirror>}){
 return <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
  <label className="flex items-center gap-2"><input type="checkbox" checked={query.autoRefreshEnabled} onChange={e=>query.setAutoRefreshEnabled(e.target.checked)}/>Refresh account reports automatically</label>
  <Button size="sm" variant="outline" disabled={query.isFetching} onClick={()=>void query.refetch()}>Refresh account reports</Button>
  <span>{query.isFetching?'Reading reports…':query.autoRefreshEnabled?'Checks every 5 seconds while visible.':'Automatic checks paused.'} Updates are reported amounts, not a guarantee of current MT5 state.</span>
 </div>;
}
