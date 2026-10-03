import { Path, Group, FabricImage, Color, util } from 'fabric';
import { memoizeImmutableNotebookImage } from './notebookAssets.js';
import { SPLIT_TOLERANCE, multiply, inverse, mapPaths, boxPath, pathBounds,
  booleanPaths, recordVectorPaints, paintPolygons, applyGeometricMask } from './notebookSplitGeometry.js';

const vectorTypes = new Set(['path','line','rect','circle','ellipse','triangle','polygon','polyline']);
const maxScale = m => Math.max(Math.hypot(m[0],m[1]),Math.hypot(m[2],m[3]),1e-6);
const dispose = o => o?.dispose?.();
const paintVisible = color => typeof color==='string' && new Color(color).getAlpha()>0;
const finiteBounds = b => [b.left,b.top,b.width,b.height].every(Number.isFinite)&&b.width>0&&b.height>0;
function vectorFragment(paths,color) {
 if(!paths.length)return null;
 const commands=paths.flatMap(path=>path.length<3?[]:[['M',path[0].x,path[0].y],...path.slice(1).map(p=>['L',p.x,p.y]),['Z']]);
 return commands.length?new Path(commands,{fill:color,stroke:null,strokeWidth:0,fillRule:'nonzero',objectCaching:false}):null;
}
function combine(parts,source) {
 const objects=parts.filter(Boolean);if(!objects.length)return null;
 const result=objects.length===1&&!source.getObjects?objects[0]:new Group(objects,{objectCaching:source.objectCaching,subTargetCheck:false});
 result.opacity=source.opacity;result.globalCompositeOperation=source.globalCompositeOperation;
 for(const key of ['objectKind','shapeType','isEraserPath'])if(source[key]!=null)result[key]=source[key];
 result.setCoords();return result;
}
function masked(paths,masks,tolerance) {
 for(const {clip,matrix} of masks)paths=applyGeometricMask(paths,clip,matrix,tolerance);
 return paths;
}
function copyMetadataToImage(canvas,left,top,density,matrix,source){
 const result=memoizeImmutableNotebookImage(new FabricImage(canvas,{originX:'center',originY:'center',objectCaching:false}));
 const placement=[1/density,0,0,1/density,left+canvas.width/(2*density),top+canvas.height/(2*density)];
 util.applyTransformToObject(result,multiply(matrix,placement));
 result.opacity=source.opacity;result.globalCompositeOperation=source.globalCompositeOperation;
 if(source.isEraserPath)result.isEraserPath=true;
 // No storagePath, mediaAssetId, cropX or old src: the encoded fragment is the
 // entire new image. The original asset is retained by history, not this object.
 return result;
}
async function renderPixelFragment(source,worldPaths,matrix,density,nativeWorld=false) {
 if(!worldPaths.length)return null;
 const paths=mapPaths(worldPaths,inverse(matrix)),b=pathBounds(paths);if(!finiteBounds(b))return null;
 const l=Math.floor(b.left*density),t=Math.floor(b.top*density),w=Math.ceil((b.left+b.width)*density)-l,h=Math.ceil((b.top+b.height)*density)-t;
 if(w>16384||h>16384||w*h>16777216)throw Error('Фрагмент изображения слишком большой для безопасного разрезания');
 const surface=util.createCanvasElement();surface.width=w;surface.height=h;
 const ctx=surface.getContext('2d',{willReadFrequently:true});if(!ctx)throw Error('Не удалось подготовить фрагмент изображения');
 let retained=null;
 try {
  ctx.scale(density,density);ctx.translate(-l/density,-t/density);
  ctx.beginPath();for(const path of paths){path.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();}ctx.clip('nonzero');
  // Render the visible source at native local resolution. Its masks have already
  // been resolved into worldPaths. This does NOT allocate a second full source.
  if(nativeWorld){
   const saved=util.saveObjectTransform(source),group=source.group,clip=source.clipPath,opacity=source.opacity,gco=source.globalCompositeOperation,canvas=source.canvas,caching=source.objectCaching;
   const world=source.calcTransformMatrix();
   try {
    delete source.group;util.applyTransformToObject(source,world);source.clipPath=undefined;source.opacity=1;source.globalCompositeOperation='source-over';source.objectCaching=false;
    source.canvas={viewportTransform:[density,0,0,density,0,0],getRetinaScaling:()=>1,getZoom:()=>density,skipOffscreen:false};
    source.render(ctx);
   }finally{source.canvas=canvas;source.objectCaching=caching;source.clipPath=clip;source.opacity=opacity;source.globalCompositeOperation=gco;source.set(saved);if(group)source.group=group;source.setCoords();}
  }else {source._renderBackground?.(ctx);source._render(ctx);}
  const data=ctx.getImageData(0,0,w,h).data;
  let x0=w,y0=h,x1=-1,y1=-1;
  for(let y=0;y<h;y++){
   for(let x=0;x<w;x++)if(data[(y*w+x)*4+3]){x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);}
   if(y&&y%512===0&&w*h>2000000)await new Promise(resolve=>setTimeout(resolve,0));
  }
  if(x1<0)return null;
  if(x0===0&&y0===0&&x1===w-1&&y1===h-1)retained=surface;
  else {retained=util.createCanvasElement();retained.width=x1-x0+1;retained.height=y1-y0+1;retained.getContext('2d').drawImage(surface,x0,y0,retained.width,retained.height,0,0,retained.width,retained.height);}
  return copyMetadataToImage(retained,(l+x0)/density,(t+y0)/density,density,matrix,source);
 } finally {if(retained!==surface)surface.width=surface.height=0;}
}
async function splitRaster(source,page,matrix,masks,retainOutside){
 // Images keep native pixels, text gets a 2x bitmap for legible glyph edges.
 const nativeWorld=Boolean(source.shadow),density=nativeWorld?1:(source instanceof FabricImage?1:2);
 const pad=Math.max(0,Number(source.strokeWidth)||0)/2;
 let rect=mapPaths(boxPath(-source.width/2-pad,-source.height/2-pad,source.width+pad*2,source.height+pad*2),matrix);
 if(nativeWorld){
  const b=source.getBoundingRect(),sc=source.shadow.nonScaling?{x:1,y:1}:source.getObjectScaling();
  const px=Math.ceil((Math.abs(source.shadow.offsetX)+source.shadow.blur*2)*sc.x)+2,py=Math.ceil((Math.abs(source.shadow.offsetY)+source.shadow.blur*2)*sc.y)+2;
  rect=boxPath(b.left-px,b.top-py,b.width+2*px,b.height+2*py);matrix=[1,0,0,1,0,0];
 }
 const region=masked(rect,masks,SPLIT_TOLERANCE);
 const insideArea=booleanPaths(region,page),outsideArea=booleanPaths(region,page,'difference');
 let inside=null,outside=null;
 try {
  inside=await renderPixelFragment(source,insideArea,matrix,density,nativeWorld);
  if(!inside&&!retainOutside)return {inside:null,outside:null};
  outside=await renderPixelFragment(source,outsideArea,matrix,density,nativeWorld);
  return {inside,outside};
 } catch(e){dispose(inside);dispose(outside);throw e;}
}
async function splitVector(source,page,matrix,masks,retainOutside){
 const tolerance=SPLIT_TOLERANCE/maxScale(matrix),{paints}=recordVectorPaints(source,tolerance);
 const inside=[],outside=[];
 try{
  if(source.backgroundColor){const d=source._getNonTransformedDimensions();paints.unshift({kind:'fill',color:source.backgroundColor,paths:boxPath(-d.x/2,-d.y/2,d.x,d.y).map(points=>({points,closed:true})),fillRule:'nonzero'});}
  for(const paint of paints){
   if(!paintVisible(paint.color))continue;
   const polygons=masked(mapPaths(paintPolygons(paint,tolerance),matrix),masks,tolerance);
   inside.push(vectorFragment(booleanPaths(polygons,page),paint.color));
   outside.push(vectorFragment(booleanPaths(polygons,page,'difference'),paint.color));
  }
  if(!inside.some(Boolean)&&!retainOutside){outside.forEach(dispose);return {inside:null,outside:null};}
  return {inside:combine(inside,source),outside:combine(outside,source)};
 }catch(e){inside.forEach(dispose);outside.forEach(dispose);throw e;}
}
async function cut(source,page,inherited=[],retainOutside=false){
 if(source.visible===false||source.opacity<=0)return {inside:null,outside:null};
 const matrix=source.calcTransformMatrix(),masks=source.clipPath?[...inherited,{clip:source.clipPath,matrix}]:inherited;
 // A group-level shadow is a paint effect on the assembled group, not on each child.
 if(source.getObjects && !source.shadow){
  const inside=[],outside=[];
  try{
   for(const child of source.getObjects()){
    // Return both visible sides even for a wholly external child. Never use an
    // artificial huge clipping rectangle or re-render a full child a second time.
    const result=await cut(child,page,masks,true);
    inside.push(result.inside);outside.push(result.outside);
   }
   if(!inside.some(Boolean)&&!retainOutside){outside.forEach(dispose);return {inside:null,outside:null};}
   return {inside:combine(inside,source),outside:combine(outside,source)};
  }catch(e){inside.forEach(dispose);outside.forEach(dispose);throw e;}
 }
 const type=String(source.type).toLowerCase();
 if(vectorTypes.has(type)&&(!source.fill||typeof source.fill==='string')&&(!source.stroke||typeof source.stroke==='string')&&!source.shadow)
  return splitVector(source,page,matrix,masks,retainOutside);
 return splitRaster(source,page,matrix,masks,retainOutside);
}

export async function splitNotebookFragments(notebook,source){
 const page=mapPaths(boxPath(-notebook.width/2,-notebook.height/2,notebook.width,notebook.height),notebook.calcTransformMatrix());
 return cut(source,page);
}
