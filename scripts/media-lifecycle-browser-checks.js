import { boardMediaAssets } from '../src/lib/mediaAssetStore.js';
import { createAuthorityBoard, deleteAuthorityBoard } from '../src/lib/browserAuthorityStore.js';
import { createPdfMedia } from '../src/lib/pdfMedia.js';
import { createGifMedia } from '../src/lib/gifMedia.js';
import { createMediaMemoryBudget } from '../src/lib/mediaMemoryBudget.js';
const check=(value,message)=>{if(!value)throw new Error(message);};

// A valid large PDF: the unused stream exercises original storage/worker loading
// without making raster complexity depend on the compressed file's byte size.
function largePdf() {
  const chunks=['%PDF-1.7\n'], offsets=[0];let length=chunks[0].length;
  const push=value=>{chunks.push(value);length+=typeof value==='string'?value.length:value.byteLength;};
  const object=(id,value)=>{offsets[id]=length;push(`${id} 0 obj\n${value}\nendobj\n`);};
  object(1,'<< /Type /Catalog /Pages 2 0 R >>');
  object(2,'<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3,'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>');
  const commands='1 0 0 rg 0 0 100 100 re f\n';object(4,`<< /Length ${commands.length} >>\nstream\n${commands}endstream`);
  const padding=100*1024*1024-4096;offsets[5]=length;
  push(`5 0 obj\n<< /Length ${padding} >>\nstream\n`);push(new Uint8Array(padding));push('\nendstream\nendobj\n');
  const xref=length;push('xref\n0 6\n0000000000 65535 f \n');
  for(let i=1;i<=5;i++)push(`${String(offsets[i]).padStart(10,'0')} 00000 n \n`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new File(chunks,'near-100MiB.pdf',{type:'application/pdf'});
}
export async function runMediaLifecycleChecks() {
  const a='large-media-a',b='large-media-b';
  await createAuthorityBoard({boardId:a});await createAuthorityBoard({boardId:b});
  const budget=createMediaMemoryBudget();
  const file=largePdf();check(file.size>99*1024*1024&&file.size<=100*1024*1024,'PDF test size');
  const pdfAsset=await boardMediaAssets.importFile(a,file);check(pdfAsset.persisted,'large PDF stored');
  const pdf=await createPdfMedia({blob:(await boardMediaAssets.get(a,pdfAsset.assetId)).blob,budget});
  try {
    const page=await pdf.renderPage(1,{pixelWidth:200});
    check(page.element.getContext('2d').getImageData(10,10,1,1).data[0]===255,'large PDF rendered');
  }finally{pdf.dispose();}
  const smallGif=await (await fetch('./fixtures/media/animated.gif')).blob();
  const gifFile=new File([smallGif,new Uint8Array(25*1024*1024-smallGif.size)],'25MiB.gif',{type:'image/gif'});
  const gifAsset=await boardMediaAssets.importFile(a,gifFile);check(gifAsset.persisted,'large GIF stored');
  const gif=await createGifMedia({blob:(await boardMediaAssets.get(a,gifAsset.assetId)).blob,budget});
  try {await gif.advance(0);check((await gif.advance(1000)).changed,'large GIF animates');}finally{gif.dispose();}
  for(const asset of [pdfAsset,gifAsset])await boardMediaAssets.register(b,asset.assetId);
  await deleteAuthorityBoard(a);
  for(const asset of [pdfAsset,gifAsset])check(await boardMediaAssets.get(b,asset.assetId),'copy keeps original');
  await deleteAuthorityBoard(b);
  for(const asset of [pdfAsset,gifAsset]) {
    check(!(await boardMediaAssets.get(b,asset.assetId)),'deleted board cannot access original');
    let absent=false;try{await boardMediaAssets.register('orphan-probe',asset.assetId);}catch{absent=true;}
    check(absent,'last reference removes original bytes');
  }
  check(budget.usedBytes()===0,'decoder reservations released');
  return {pdfBytes:file.size,gifBytes:gifFile.size,pdfRendered:true,gifAnimated:true,lastBoardCleanup:true};
}
