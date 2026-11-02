/** Preserve the finite numeric endpoint value; no currency or observation-time
 * proof is implied. This endpoint does not provide native decimal strings. */
export function formatReportedPositionPnl(value:number|null|undefined):string {
 if(typeof value!=='number'||!Number.isFinite(value))return '—';
 return (value>=0?'+':'')+String(Object.is(value,-0)?0:value);
}
