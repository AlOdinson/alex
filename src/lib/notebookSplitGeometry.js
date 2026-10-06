// The pure implementation is shared by the worker and legacy mask fallback.
export { SPLIT_TOLERANCE, multiply, inverse, mapPoint, mapPaths, boxPath, pathBounds,
 booleanPaths, recordVectorPaints, paintPolygons } from './notebookSplitGeometryCore.js';
import { SPLIT_TOLERANCE, multiply, mapPaths, booleanPaths, recordVectorPaints } from './notebookSplitGeometryCore.js';

// Native clip paths draw filled silhouettes, not their stroke colour. Resolve
// relative/absolute transforms, holes, groups, nested clips and inversion once.
export function applyGeometricMask(subject,clip,parentMatrix,tolerance=SPLIT_TOLERANCE){
 if(!clip||!subject.length)return subject;
 const matrix=clip.absolutePositioned?clip.calcOwnMatrix():multiply(parentMatrix,clip.calcOwnMatrix());
 let region=[];
 if(clip.visible!==false){
  if(clip.getObjects){
   for(const child of clip.getObjects())region.push(...applyGeometricMask(subject,child,matrix,tolerance));
   region=booleanPaths(region,[],'union');
  }else{
   const contours=recordVectorPaints(clip,tolerance).contours.map(p=>p.points);
   const shape=booleanPaths(mapPaths(contours,matrix),[],'union',clip.fillRule);
   region=booleanPaths(subject,shape);
  }
  if(clip.clipPath)region=applyGeometricMask(region,clip.clipPath,matrix,tolerance);
 }
 return clip.inverted?booleanPaths(subject,region,'difference'):region;
}
