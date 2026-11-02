// Isolated actual component fixture only. No account, API or trading client.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PositionMiniChart, type PositionMiniChartProps } from '../../../artifacts/trading-dashboard/src/components/positions/PositionMiniChart';
import '../../../artifacts/trading-dashboard/src/index.css';

const bars=Array.from({length:80},(_,i)=>({time:(1767355200-(80-i)*900)*1000,
 open:1.1+i/10000,high:1.1004+i/10000,low:1.0998+i/10000,close:1.1002+i/10000}));
function Fixture(){
 const [props,setProps]=useState<PositionMiniChartProps>({symbol:'EURUSD',side:'BUY',entryPrice:1.104,currentPrice:1.1081,stopLoss:1.101,takeProfit:1.109,candles:bars,displayStatus:'LIVE',height:260});
 return <main style={{padding:24,maxWidth:900,margin:'auto'}}>
  <p role="status" style={{color:'#fbbf24',marginBottom:16}}>OFFLINE QA — synthetic position and candles. The LIVE prop is a simulated display-contract input, not a real feed. No account, broker or trading connection.</p>
  <div className="flex flex-wrap gap-3 mb-4">
   <button onClick={()=>setProps(p=>{const price=p.currentPrice===1.1082?1.1081:1.1082;return {...p,currentPrice:price,candles:p.candles.map((c,i)=>i===p.candles.length-1?{...c,close:price,high:1.1083}:c)};})}>Update supplied snapshot</button>
   <button onClick={()=>setProps(p=>({...p,displayStatus:'STALE'}))}>Withdraw live verdict</button>
   <button onClick={()=>setProps(p=>({...p,symbol:'GBPUSD'}))}>Change symbol</button>
   <button onClick={()=>setProps(p=>({...p,candles:[]}))}>Clear candles</button>
   <button onClick={()=>setProps(p=>({...p,candles:bars}))}>Restore candles</button>
  </div>
  <output data-testid="position-mini-supplied-candles" hidden>{JSON.stringify(props.candles)}</output>
  <PositionMiniChart {...props}/>
  <p style={{marginTop:20}}>Entry time and original clock authority were not supplied.</p>
  <div style={{height:800}} aria-hidden="true"/>
 </main>;
}
export function mountPositionMiniFixture(){createRoot(document.getElementById('root')!).render(<Fixture/>);}
