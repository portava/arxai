async page => {
 await page.goto('http://127.0.0.1:4178');await page.setViewportSize({width:1600,height:1100});await page.getByTestId('arx-native-canvas').first().waitFor();await page.waitForLoadState('networkidle');
 return await page.evaluate(async()=>{const {runWorkspaceBenchmark}=await import('/workspace-benchmark.ts');const result=await runWorkspaceBenchmark();if(result.acceptedUpdates!==4800)throw Error('Incomplete tick workload: '+JSON.stringify(result));if(!result.rangeAligned)throw Error('Real-engine range link did not converge: '+JSON.stringify(result));return result;});
}
