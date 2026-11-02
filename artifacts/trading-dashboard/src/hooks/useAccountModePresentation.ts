import {useQuery} from '@tanstack/react-query';
import {useTradingMode} from './useTradingMode';
import {describeAccountMode,type SafetyReadEvidence} from '@/lib/accountModePresentation';
const BASE=(import.meta.env.BASE_URL||'/').replace(/\/$/,'');
/** Reuse the existing direct kill-switch query, independently of mode reads.
 * Both display surfaces share its cache; no new execution decision or endpoint. */
export function useAccountModePresentation(){
 const mode=useTradingMode();
 const safety=useQuery<NonNullable<SafetyReadEvidence['data']>>({
  queryKey:['live','arming','kill-switch-only'],
  queryFn:async()=>{const response=await fetch(`${BASE}/api/me/live/arming`,{credentials:'include',cache:'no-store'});if(!response.ok)throw new Error('Safety status unavailable');return response.json();},
  refetchInterval:15_000,staleTime:10_000,
 });
 return describeAccountMode(mode,safety);
}
