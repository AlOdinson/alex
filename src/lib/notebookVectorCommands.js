import { Color } from 'fabric';

// Record native Fabric primitives WITHOUT flattening Beziers/ellipses or offsetting
// strokes. The worker replays these plain commands using the canonical recorder.
export function recordNotebookVectorCommands(object) {
  const commands=[], stack=[];
  let style={fillStyle:'#000',strokeStyle:'#000',lineWidth:1,lineCap:'butt',
    lineJoin:'miter',miterLimit:10,lineDashOffset:0,dash:[]};
  const ctx={};
  const copy=value=>Array.isArray(value)?value.slice():value;
  for(const key of Object.keys(style)) Object.defineProperty(ctx,key,{
    get:()=>style[key],set:value=>{style[key]=copy(value);commands.push(['style',key,copy(value)]);},
  });
  for(const name of ['beginPath','moveTo','lineTo','closePath','rect','bezierCurveTo',
    'quadraticCurveTo','arc','ellipse','transform','translate','scale','rotate']) {
    ctx[name]=(...args)=>commands.push([name,...args]);
  }
  ctx.save=()=>{stack.push({...style});commands.push(['save']);};
  ctx.restore=()=>{if(stack.length)style=stack.pop();commands.push(['restore']);};
  ctx.setLineDash=d=>{style.dash=d.slice();commands.push(['setLineDash',d.slice()]);};
  const visible=color=>typeof color==='string'&&new Color(color).getAlpha()>0;
  ctx.fill=(rule='nonzero')=>{if(visible(style.fillStyle))commands.push(['fill',rule]);};
  ctx.stroke=()=>{if(visible(style.strokeStyle))commands.push(['stroke']);};
  object._render(ctx);
  return commands;
}
