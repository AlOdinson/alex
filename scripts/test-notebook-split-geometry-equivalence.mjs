import test from 'node:test';
import assert from 'node:assert/strict';
import {getEnv} from 'fabric/node';
import {setEnv,Path,Rect,Ellipse,Circle,Polygon,util} from 'fabric';
import * as old from './fixtures/notebook-split-geometry-273255ca.js';
import * as core from '../src/lib/notebookSplitGeometryCore.js';
import {recordNotebookVectorCommands} from '../src/lib/notebookVectorCommands.js';
setEnv(getEnv());
const factories=[
 ()=>new Path('M 20 150 C 90 10 260 360 380 150 Q 400 250 420 90',{fill:null,stroke:'red',strokeWidth:9,strokeLineCap:'round',strokeLineJoin:'round'}),
 ()=>new Path('M 20 150 L 300 200 L 220 300',{fill:null,stroke:'blue',strokeWidth:11,strokeUniform:true,scaleX:1.273,scaleY:.483,skewX:13,angle:27}),
 ()=>new Path('M 20 150 L 300 200 L 220 300',{fill:null,stroke:'blue',strokeWidth:11,strokeDashArray:[17,9],strokeDashOffset:3,strokeLineJoin:'bevel'}),
 ()=>new Path('M 20 150 L 300 200 L 220 300',{fill:null,stroke:'blue',strokeWidth:11,strokeLineJoin:'miter',strokeMiterLimit:2}),
 ()=>new Rect({left:140,top:120,width:150,height:70,rx:23,ry:11,fill:'red',stroke:'blue',strokeWidth:8,angle:23}),
 ()=>new Ellipse({left:130,top:180,rx:73,ry:34,angle:17,fill:null,stroke:'black',strokeWidth:7}),
 ()=>new Circle({left:110,top:140,radius:45,fill:'red',stroke:'black',strokeWidth:9}),
 ()=>new Polygon([{x:10,y:50},{x:310,y:100},{x:100,y:310}],{fill:'green',stroke:'black',strokeWidth:3}),
 ()=>new Path('M 0 0 L 400 0 L 400 400 L 0 400 Z M 100 100 L 300 100 L 300 300 L 100 300 Z',{fill:'red',fillRule:'evenodd',stroke:null}),
];
for(const [i,factory] of factories.entries())test(`shared worker geometry matches pinned pre-worker implementation: shape ${i}`,()=>{
 const source=factory();try{
  const matrix=source.calcTransformMatrix(),tolerance=.01/Math.max(Math.hypot(...matrix.slice(0,2)),Math.hypot(...matrix.slice(2,4)),1e-6);
  const commands=recordNotebookVectorCommands(source),paints=old.recordVectorPaints(source,tolerance).paints;
  assert.deepEqual(core.replayVectorCommands(commands,tolerance).paints,paints,'native command replay changed geometry');
  const page=old.boxPath(100,100,200,200);
  const expected=paints.map(p=>{const poly=old.mapPaths(old.paintPolygons(p,tolerance),matrix);return{color:p.color,inside:old.booleanPaths(poly,page),outside:old.booleanPaths(poly,page,'difference')};});
  assert.deepEqual(core.splitVectorPaintsTask({commands,page,matrix,tolerance}),expected);
 }finally{source.dispose();}
});
test('pure matrix helpers preserve exact Fabric arithmetic',()=>{
 for(let i=1;i<=80;i++){
  const a=[1.3+i/71,.27,.31,2.1-i/105,35.39*i,91.283-i],b=[.11,1.34,2.48,.74,-37.19,56.17];
  assert.deepEqual(core.inverse(a),util.invertTransform(a));assert.deepEqual(core.multiply(a,b),util.multiplyTransformMatrices(a,b));
 }
});
