export interface AssistantViewport {width:number;height:number;offsetLeft:number;offsetTop:number;layoutHeight:number}
/** Visible-viewport coordinates, not guessed keyboard height. This is a layout
 * bound, not a promise that a useful plot fits beside every keyboard. */
export function chartAssistantBounds(viewport:AssistantViewport,expanded:boolean){
 const width=Math.max(1,viewport.width),height=Math.max(1,viewport.height);
 const inset=Math.min(8,width/4,height/4);
 const keyboardReduced=height<viewport.layoutHeight-120;
 const bottom=keyboardReduced?inset:Math.min(80,height*.15);
 const available=Math.max(1,height-bottom-inset);
 const panelHeight=expanded||height<360?Math.min(760,available):Math.min(340,Math.max(176,height*.4),available);
 const panelWidth=Math.min(440,Math.max(1,width-2*inset));
 return {top:viewport.offsetTop+height-bottom-panelHeight,left:viewport.offsetLeft+width-inset-panelWidth,width:panelWidth,height:panelHeight};
}
