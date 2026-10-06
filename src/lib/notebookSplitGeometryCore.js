import ClipperLib from 'clipper-lib';

// A cut is computed once, not on render/zoom. Integer boolean operations keep
// holes and disjoint remnants; curves are flattened to <= 0.01 board unit.
export const SPLIT_TOLERANCE = 0.01;
const SCALE = 4096, LIMIT = 200000;
const I = [1, 0, 0, 1, 0, 0];
// Same evaluation order as Fabric's matrix helpers, including translation.
export const multiply = (a,b,is2x2=false) => [
 a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
 a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
 is2x2?0:a[0]*b[4]+a[2]*b[5]+a[4], is2x2?0:a[1]*b[4]+a[3]*b[5]+a[5],
];
export const inverse = t => {
 const a=1/(t[0]*t[3]-t[1]*t[2]);
 const r=[a*t[3],-a*t[1],-a*t[2],a*t[0],0,0];
 r[4]=-(r[0]*t[4]+r[2]*t[5]+0); r[5]=-(r[1]*t[4]+r[3]*t[5]+0);
 return r;
};
export const mapPoint = (p, m) => ({ x:m[0]*p.x+m[2]*p.y+m[4], y:m[1]*p.x+m[3]*p.y+m[5] });
export const mapPaths = (paths, m) => paths.map(path => path.map(p => mapPoint(p, m)));
export const boxPath = (left, top, width, height) => [[{x:left,y:top},{x:left+width,y:top},{x:left+width,y:top+height},{x:left,y:top+height}]];
export function pathBounds(paths) {
 let l=Infinity,t=Infinity,r=-Infinity,b=-Infinity;
 for(const path of paths)for(const p of path){l=Math.min(l,p.x);t=Math.min(t,p.y);r=Math.max(r,p.x);b=Math.max(b,p.y);}
 return {left:l,top:t,width:r-l,height:b-t};
}
const integerPaths = paths => paths.map(path=>path.map(p=>{
 if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.max(Math.abs(p.x),Math.abs(p.y))>1e9)throw Error('Слишком большие координаты для разрезания');
 return {X:Math.round(p.x*SCALE),Y:Math.round(p.y*SCALE)};
})).filter(path=>path.length>=3);
const floatPaths = paths => paths.map(path=>path.map(p=>({x:p.X/SCALE,y:p.Y/SCALE})));
const rule = value => value==='evenodd'?ClipperLib.PolyFillType.pftEvenOdd:ClipperLib.PolyFillType.pftNonZero;
export function booleanPaths(subject, clip=[], type='intersection', fillRule='nonzero') {
 const a=integerPaths(subject),b=integerPaths(clip);
 if(!a.length)return [];
 if(type==='intersection'&&!b.length)return [];
 const c=new ClipperLib.Clipper();c.StrictlySimple=true;
 c.AddPaths(a,ClipperLib.PolyType.ptSubject,true);if(b.length)c.AddPaths(b,ClipperLib.PolyType.ptClip,true);
 const result=[];
 c.Execute({intersection:0,union:1,difference:2,xor:3}[type],result,rule(fillRule),ClipperLib.PolyFillType.pftNonZero);
 return floatPaths(result);
}
const distance = (a,b) => Math.hypot(b.x-a.x,b.y-a.y);
const midpoint = (a,b) => ({x:(a.x+b.x)/2,y:(a.y+b.y)/2});
function lineDistance(p,a,b){const d=distance(a,b);return d?Math.abs((p.x-a.x)*(b.y-a.y)-(p.y-a.y)*(b.x-a.x))/d:distance(p,a);}

// Record Fabric's native primitive paths instead of maintaining divergent shape
// formulas (rounded rectangles, ellipses, normalized SVG arcs, polygons, etc.).
export function recordVectorPaints(object, tolerance=SPLIT_TOLERANCE) {
 let paths=[],current=null,m=I.slice(),stack=[],paints=[],count=0;
 const add=p=>{if(++count>LIMIT)throw Error('Слишком сложная фигура для разрезания');if(!current){current={points:[],closed:false};paths.push(current);}const last=current.points.at(-1);if(!last||distance(last,p)>1e-10)current.points.push(p);};
 const cubic=(a,b,c,d,depth=0)=>{
  if(depth>=18||(Math.max(lineDistance(b,a,d),lineDistance(c,a,d))<=tolerance
    && distance(a,b)+distance(b,c)+distance(c,d)-distance(a,d)<=tolerance*2)){add(d);return;}
  const ab=midpoint(a,b),bc=midpoint(b,c),cd=midpoint(c,d),abc=midpoint(ab,bc),bcd=midpoint(bc,cd),mid=midpoint(abc,bcd);
  cubic(a,ab,abc,mid,depth+1);cubic(mid,bcd,cd,d,depth+1);
 };
 const snapshot=()=>paths.map(path=>({points:path.points.map(p=>({...p})),closed:path.closed}));
 const ctx={
  fillStyle:'#000',strokeStyle:'#000',lineWidth:1,lineCap:'butt',lineJoin:'miter',miterLimit:10,lineDashOffset:0,dash:[],
  beginPath(){paths=[];current=null;},
  moveTo(x,y){current={points:[],closed:false};paths.push(current);add(mapPoint({x,y},m));},
  lineTo(x,y){add(mapPoint({x,y},m));},
  closePath(){if(current)current.closed=true;},
  rect(x,y,w,h){this.moveTo(x,y);this.lineTo(x+w,y);this.lineTo(x+w,y+h);this.lineTo(x,y+h);this.closePath();},
  bezierCurveTo(x1,y1,x2,y2,x,y){const d=mapPoint({x,y},m),a=current?.points.at(-1);if(!a){add(d);return;}cubic(a,mapPoint({x:x1,y:y1},m),mapPoint({x:x2,y:y2},m),d);},
  quadraticCurveTo(x1,y1,x,y){const a=current?.points.at(-1),b=mapPoint({x:x1,y:y1},m),d=mapPoint({x,y},m);if(!a){add(d);return;}cubic(a,{x:a.x+(b.x-a.x)*2/3,y:a.y+(b.y-a.y)*2/3},{x:d.x+(b.x-d.x)*2/3,y:d.y+(b.y-d.y)*2/3},d);},
  arc(x,y,r,start,end,ccw=false){this.ellipse(x,y,r,r,0,start,end,ccw);},
  ellipse(x,y,rx,ry,rotation,start,end,ccw=false){
   const tau=Math.PI*2;let span=end-start;
   if(!ccw){if(span>=tau)span=tau;else span=((span%tau)+tau)%tau;}else{if(span<=-tau)span=-tau;else span=-(((-span%tau)+tau)%tau);}
   const norm=Math.max(Math.hypot(m[0],m[1]),Math.hypot(m[2],m[3]));
   const radius=Math.max(rx,ry)*norm,step=radius>tolerance?2*Math.acos(Math.max(-1,1-tolerance/radius)):Math.PI/2;
   const n=Math.max(1,Math.ceil(Math.abs(span)/Math.max(1e-4,step)));
   if(n>LIMIT)throw Error('Слишком сложная дуга для разрезания');
   for(let i=0;i<=n;i++){const a=start+span*i/n,dx=rx*Math.cos(a),dy=ry*Math.sin(a);add(mapPoint({x:x+dx*Math.cos(rotation)-dy*Math.sin(rotation),y:y+dx*Math.sin(rotation)+dy*Math.cos(rotation)},m));}
  },
  save(){stack.push({m:m.slice(),style:Object.fromEntries(['fillStyle','strokeStyle','lineWidth','lineCap','lineJoin','miterLimit','lineDashOffset','dash'].map(k=>[k,this[k]]))});},
  restore(){const s=stack.pop();if(s){m=s.m;Object.assign(this,s.style);}},
  transform(...v){m=multiply(m,v);},translate(x,y){this.transform(1,0,0,1,x,y);},scale(x,y){this.transform(x,0,0,y,0,0);},rotate(a){this.transform(Math.cos(a),Math.sin(a),-Math.sin(a),Math.cos(a),0,0);},
  setLineDash(d){this.dash=d.slice();},
  fill(fillRule='nonzero'){paints.push({kind:'fill',paths:snapshot(),color:this.fillStyle,fillRule});},
  stroke(){paints.push({kind:'stroke',paths:snapshot(),color:this.strokeStyle,matrix:m.slice(),width:this.lineWidth,cap:this.lineCap,join:this.lineJoin,miter:this.miterLimit,dash:this.dash.slice(),offset:this.lineDashOffset});},
 };
 object._render(ctx);
 return {paints,contours:snapshot()};
}
function dashed(paths,pattern,offset=0){
 const d=pattern.map(Math.abs);if(!d.length||d.every(v=>v===0))return paths;
 if(d.length%2)d.push(...d);const length=d.reduce((a,b)=>a+b,0),result=[];
 for(const path of paths){
  const points=path.closed?[...path.points,path.points[0]]:path.points;if(points.length<2)continue;
  let index=0,used=((offset%length)+length)%length;
  while(used>=d[index]){used-=d[index];index=(index+1)%d.length;}
  let remain=d[index]-used,part=null;
  const push=(a,b)=>{if(!part){part={points:[a],closed:false};result.push(part);}part.points.push(b);};
  for(let i=1;i<points.length;i++){
   let a=points[i-1],end=points[i],len=distance(a,end);
   while(len>1e-9){
    if(remain<1e-9){index=(index+1)%d.length;remain=d[index];if(index%2)part=null;continue;}
    const take=Math.min(len,remain),f=take/len,b={x:a.x+(end.x-a.x)*f,y:a.y+(end.y-a.y)*f};
    if(!(index%2))push(a,b);a=b;len-=take;remain-=take;
   }
  }
 }
 return result;
}
function hardJoinStroke(paths,paint,tolerance){
 const shapes=[],r=paint.width/2;
 const add=points=>{
  let area=0;for(let i=0;i<points.length;i++){const p=points[i],q=points[(i+1)%points.length];area+=p.x*q.y-q.x*p.y;}
  if(Math.abs(area)>1e-12)shapes.push(area>0?points:points.reverse());
 };
 const cross=(a,b)=>a.x*b.y-a.y*b.x;
 const disk=p=>{const n=Math.max(12,Math.ceil(Math.PI/Math.acos(Math.max(-1,1-tolerance/r))));add(Array.from({length:n},(_,i)=>({x:p.x+r*Math.cos(i*Math.PI*2/n),y:p.y+r*Math.sin(i*Math.PI*2/n)})));};
 for(const path of paths){
  const pts=path.points.filter((p,i,a)=>!i||distance(p,a[i-1])>1e-9);
  if(pts.length>1&&distance(pts[0],pts.at(-1))<1e-9)pts.pop();
  if(pts.length<2){if(pts.length&&paint.cap==='round')disk(pts[0]);continue;}
  const segments=[];
  for(let i=0;i<pts.length-(path.closed?0:1);i++){
   const a=pts[i],b=pts[(i+1)%pts.length],length=distance(a,b);if(!length)continue;
   const d={x:(b.x-a.x)/length,y:(b.y-a.y)/length},n={x:-d.y*r,y:d.x*r};segments.push({a,b,d,n});
   add([{x:a.x+n.x,y:a.y+n.y},{x:b.x+n.x,y:b.y+n.y},{x:b.x-n.x,y:b.y-n.y},{x:a.x-n.x,y:a.y-n.y}]);
  }
  for(let i=path.closed?0:1;i<segments.length;i++){
   const prev=segments[(i+segments.length-1)%segments.length],next=segments[i],p=next.a,turn=cross(prev.d,next.d);
   if(Math.abs(turn)<1e-10)continue;
   const side=-Math.sign(turn),a={x:p.x+prev.n.x*side,y:p.y+prev.n.y*side},b={x:p.x+next.n.x*side,y:p.y+next.n.y*side};
   const t=cross({x:b.x-a.x,y:b.y-a.y},next.d)/turn,tip={x:a.x+t*prev.d.x,y:a.y+t*prev.d.y};
   add(paint.join==='miter'&&distance(p,tip)/r<=(paint.miter||4)?[p,a,tip,b]:[p,a,b]);
  }
  if(!path.closed&&segments.length){
   for(const [s,p,sign]of [[segments[0],pts[0],-1],[segments.at(-1),pts.at(-1),1]]){
    if(paint.cap==='round')disk(p);
    else if(paint.cap==='square'){const dx=s.d.x*r*sign,dy=s.d.y*r*sign;add([{x:p.x+s.n.x,y:p.y+s.n.y},{x:p.x+s.n.x+dx,y:p.y+s.n.y+dy},{x:p.x-s.n.x+dx,y:p.y-s.n.y+dy},{x:p.x-s.n.x,y:p.y-s.n.y}]);}
   }
  }
 }
 return booleanPaths(shapes,[],'union');
}
export function paintPolygons(paint,tolerance=SPLIT_TOLERANCE){
 if(paint.kind==='fill')return booleanPaths(paint.paths.map(p=>p.points),[],'union',paint.fillRule);
 if(!(paint.width>0))return [];
 const back=inverse(paint.matrix),input=dashed(paint.paths.map(p=>({...p,points:mapPaths([p.points],back)[0]})),paint.dash,paint.offset);
 if(paint.join==='bevel'||paint.join==='miter')return mapPaths(hardJoinStroke(input,paint,tolerance),paint.matrix);
 const co=new ClipperLib.ClipperOffset(paint.miter||4,Math.max(0.1,tolerance*SCALE));
 const join={round:ClipperLib.JoinType.jtRound,miter:ClipperLib.JoinType.jtMiter,bevel:ClipperLib.JoinType.jtSquare}[paint.join]??ClipperLib.JoinType.jtRound;
 for(const path of input){
  const pts=path.points.map(p=>({X:Math.round(p.x*SCALE),Y:Math.round(p.y*SCALE)}));
  if(!pts.length)continue;
  // A dot has visible area with round/square caps, but not with a butt cap.
  if(pts.length<2&&paint.cap==='butt')continue;
  co.AddPath(pts,join,path.closed?ClipperLib.EndType.etClosedLine:({round:ClipperLib.EndType.etOpenRound,square:ClipperLib.EndType.etOpenSquare}[paint.cap]??ClipperLib.EndType.etOpenButt));
 }
 const out=[];co.Execute(out,paint.width*SCALE/2);
 return mapPaths(floatPaths(out),paint.matrix);
}


const commandMethods = new Set(['beginPath','moveTo','lineTo','closePath','rect',
 'bezierCurveTo','quadraticCurveTo','arc','ellipse','save','restore','transform',
 'translate','scale','rotate','setLineDash','fill','stroke']);
const commandStyles = new Set(['fillStyle','strokeStyle','lineWidth','lineCap',
 'lineJoin','miterLimit','lineDashOffset','dash']);
export function replayVectorCommands(commands,tolerance=SPLIT_TOLERANCE) {
 if(!Array.isArray(commands))throw new TypeError('Invalid notebook drawing commands');
 return recordVectorPaints({_render(ctx){
  for(const command of commands){
   const [method,...args]=command;
   if(method==='style' && commandStyles.has(args[0]))ctx[args[0]]=args[1];
   else if(commandMethods.has(method))ctx[method](...args);
   else throw new TypeError('Unsupported notebook drawing command');
  }
 }},tolerance);
}
export function splitVectorPaintsTask({paints,commands,background,page,matrix,tolerance}){
 if(!Array.isArray(page)||!Array.isArray(matrix)||matrix.length!==6
   || !matrix.every(Number.isFinite) || !(tolerance>0) || !Number.isFinite(tolerance)) {
  throw new TypeError('Invalid notebook vector split task');
 }
 if(commands)paints=replayVectorCommands(commands,tolerance).paints;
 if(!Array.isArray(paints))throw new TypeError('Invalid notebook paints');
 if(background)paints=[background,...paints];
 return paints.map(paint=>{
  const polygons=mapPaths(paintPolygons(paint,tolerance),matrix);
  return {color:paint.color,inside:booleanPaths(polygons,page),outside:booleanPaths(polygons,page,'difference')};
 });
}
export { booleanPaths as booleanPathsCore, paintPolygons as paintPolygonsCore };
