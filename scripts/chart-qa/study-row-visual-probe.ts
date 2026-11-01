import {createChart,LineSeries,AreaSeries,BaselineSeries,HistogramSeries,CandlestickSeries,BarSeries,type UTCTimestamp,type Time} from 'lightweight-charts';

/** Synthetic native-canvas comparison. This does not measure the Scanner route. */
export async function runStudyRowVisualProbe(){
 const frame=()=>new Promise<number>(requestAnimationFrame);
 await document.fonts.ready;
 const host=document.createElement('div');host.style.cssText='position:fixed;left:12px;top:12px;width:720px;height:420px;z-index:99999;background:#111827';document.body.append(host);
 const records:any[]=[];
 const digest=async (bytes:Uint8ClampedArray)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.slice().buffer))).map(x=>x.toString(16).padStart(2,'0')).join('');
 try{
  for(const [type,definition] of Object.entries({Line:LineSeries,Area:AreaSeries,Baseline:BaselineSeries,Histogram:HistogramSeries,Candlestick:CandlestickSeries,Bar:BarSeries})){
   for(const overrides of [false,true])for(const conflation of [false,true])for(const mode of [0,1,2,3] as const){
    const chart=createChart(host,{width:720,height:420,layout:{background:{type:'solid' as any,color:'#111827'},textColor:'#d1d5db',fontFamily:'Arial',fontSize:12},rightPriceScale:{mode},localization:{locale:'en-US',timeFormatter:(t:Time)=>String(t)},timeScale:{enableConflation:conflation,conflationThresholdFactor:4,minBarSpacing:.05,timeVisible:true,tickMarkFormatter:(t:Time)=>String(t).slice(-4)}});
    try{
     const options={color:'#60a5fa',lineColor:'#60a5fa',topColor:'#14532d',bottomColor:'#1e3a8a',baseValue:{type:'price',price:100},topLineColor:'#34d399',bottomLineColor:'#f87171',topFillColor1:'#14532d',topFillColor2:'#052e16',bottomFillColor1:'#7f1d1d',bottomFillColor2:'#450a0a',upColor:'#34d399',downColor:'#f87171',wickUpColor:'#6ee7b7',wickDownColor:'#fca5a5',borderUpColor:'#a7f3d0',borderDownColor:'#fecaca',priceLineVisible:false,lastValueVisible:false};
     const series=chart.addSeries(definition as any,options as any);
     const ohlc=type==='Candlestick'||type==='Bar';
     let data=Array.from({length:2048},(_,i)=>{
      const value=100+Math.sin(i/11)*3,alternate=i%2===0;
      const colours=overrides?{color:alternate?'#e879f9':'#38bdf8',lineColor:alternate?'#e879f9':'#38bdf8',topColor:alternate?'#581c87':'#0c4a6e',bottomColor:alternate?'#3b0764':'#082f49',topLineColor:alternate?'#e879f9':'#a3e635',bottomLineColor:alternate?'#facc15':'#fb7185',topFillColor1:'#3b0764',topFillColor2:'#581c87',bottomFillColor1:'#713f12',bottomFillColor2:'#422006',wickColor:'#fef08a',borderColor:'#ffffff'}:{};
      return{time:(1700000000+i*60) as UTCTimestamp,...(ohlc?{open:value-.2,high:value+.5,low:value-.5,close:value}:{value}),...colours};
     });
     series.setData(data as any);chart.timeScale().fitContent();
     const last=data.at(-1)!;const updated={...last,...(ohlc?{close:(last as any).close+.03}:{value:(last as any).value+.03})};series.update(updated as any);data[data.length-1]=updated;
     const repaint={color:'#fb923c',lineColor:'#fb923c',topColor:'#9a3412',bottomColor:'#431407',topLineColor:'#fb923c',bottomLineColor:'#facc15',topFillColor1:'#9a3412',topFillColor2:'#431407',bottomFillColor1:'#854d0e',bottomFillColor2:'#422006',upColor:'#fb923c',downColor:'#facc15',wickUpColor:'#fdba74',wickDownColor:'#fde047',borderUpColor:'#fed7aa',borderDownColor:'#fef08a'};
     const palette=new Set([...Object.values(options),...Object.values(repaint),...data.flatMap(row=>Object.values(row))].filter((v):v is string=>typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v)).map(v=>parseInt(v.slice(1),16)));
     const capture=async(phase:string,expected:any[])=>{
      await frame();await frame();await frame();
      const screenshot=chart.takeScreenshot(),ctx=screenshot.getContext('2d')!,pixels=ctx.getImageData(0,0,screenshot.width,screenshot.height).data;
      const pixelHash=await digest(pixels);await frame();const second=chart.takeScreenshot();const stable=pixelHash===await digest(second.getContext('2d')!.getImageData(0,0,second.width,second.height).data);
      const canonical=(rows:any[])=>rows.map(r=>ohlc?[r.time,r.open,r.high,r.low,r.close]:[r.time,r.value]);
      const dataCorrect=JSON.stringify(canonical([...series.data()]))===JSON.stringify(canonical(expected));
      let distinct=0,inkPixels=0;for(let i=0;i<pixels.length;i+=4){if(pixels[i]!==pixels[0]||pixels[i+1]!==pixels[1]||pixels[i+2]!==pixels[2])distinct++;if(palette.has((pixels[i]!<<16)|(pixels[i+1]!<<8)|pixels[i+2]!))inkPixels++;}
      const box=host.getBoundingClientRect(),visible=box.left>=0&&box.top>=0&&box.right<=innerWidth&&box.bottom<=innerHeight&&host.contains(document.elementFromPoint(box.left+box.width/2,box.top+box.height/2));
      records.push({type,overrides,conflation,mode,phase,pixelHash,width:screenshot.width,height:screenshot.height,stable,dataCorrect,expectedRows:expected.length,distinctPixels:distinct,inkPixels,visible,logicalRange:chart.timeScale().getVisibleLogicalRange()});
     };
     await capture('initial',data);
     series.applyOptions(repaint);await capture('options-only',data);
     const combined={...data.at(-1)!,...(ohlc?{close:(data.at(-1) as any).close+.11}:{value:(data.at(-1) as any).value+.11})};data[data.length-1]=combined;series.update(combined as any);series.applyOptions(options as any);await capture('data-and-options',data);
     data=data.map((row,i)=>i===500?{...row,...(ohlc?{close:(row as any).close+.21}:{value:(row as any).value+.21})}:row);series.setData(data as any);await capture('historical-correction',data);
     series.setData([]);await capture('clear',[]);
     series.setData(data as any);chart.timeScale().fitContent();await capture('repopulate',data);
    }finally{chart.remove();}
   }
  }
  return {records,valid:records.length===576&&records.every(r=>r.stable&&r.dataCorrect&&(!r.expectedRows||(r.distinctPixels>100&&r.inkPixels>0))&&r.visible),limits:['Six built-in series, four scales, colour overrides, grouping, six lifecycle phases; not full ARX seven-style acceptance','Canvas pixels are synthetic; no navigation latency, provider or physical paint claim']};
 }finally{host.remove();}
}
