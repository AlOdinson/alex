import { parseGIF, decompressFrame } from 'gifuct-js';
let gif,frames;
self.onmessage=({data})=>{
  const {id,type}=data;
  try {
    if(type==='init'){
      gif=parseGIF(data.bytes);frames=gif.frames.filter(frame=>frame.image);
      const width=gif.lsd.width,height=gif.lsd.height;
      if(!width || !height || width*height>4_000_000 || !frames.length || frames.length>10000)throw new Error('Слишком большой или повреждённый GIF');
      for(const frame of frames){const d=frame.image.descriptor;if(!d.width || !d.height || d.width*d.height>width*height || d.left+d.width>width || d.top+d.height>height)throw new Error('Повреждённый кадр GIF');}
      const extension=gif.frames.find(frame=>/^(NETSCAPE2.0|ANIMEXTS1.0)$/.test(frame.application?.id || ''))?.application;
      const repeats=extension?extension.blocks[1]+256*extension.blocks[2]:null;
      const transparent=frames[0].gce?.extras.transparentColorGiven;
      const background=transparent?null:gif.gct?.[gif.lsd.backgroundColorIndex];
      self.postMessage({id,result:{width,height,frameCount:frames.length,loops:repeats===null?1:repeats===0?Infinity:repeats+1,background}});
    }else if(type==='frame'){
      const raw=frames[data.index];if(!raw)throw new Error('Кадр GIF отсутствует');
      const decoded=decompressFrame(raw,gif.gct,true);
      const result={dims:decoded.dims,patch:decoded.patch,disposalType:decoded.disposalType || 0,
        delay:Math.max(10,(raw.gce?.delay ?? 10)*10)};
      self.postMessage({id,result},[result.patch.buffer]);
    }
  }catch(error){self.postMessage({id,error:error.message});}
};
