export function collectMediaAssetIds(value) {
  const ids=new Set();
  const visit=item=>{
    if(!item || typeof item!=='object')return;
    if(item.mediaAssetId)ids.add(String(item.mediaAssetId));
    for(const child of Object.values(item))visit(child);
  };
  visit(value);return [...ids];
}
export const MEDIA_UPDATE_MESSAGE='Для PDF/GIF обновите страницу доски. / Refresh this board to view PDFs and GIFs.';
export function mediaUpdateSnapshot(snapshot) {
  return {...snapshot,canvas:{...(snapshot?.canvas || {}),objects:[{type:'Textbox',version:'7.4.0',
    boardObjectId:'media-update-required',left:160,top:180,originX:'left',originY:'top',width:640,
    fontSize:28,fontFamily:'Arial',fill:'#111827',text:MEDIA_UPDATE_MESSAGE,editable:false}]}};
}
