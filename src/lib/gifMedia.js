function createWorkerDecoder() {
  const worker=new Worker(new URL('./gifMediaWorker.js',import.meta.url),{type:'module'});
  const pending=new Map();let next=0,closed=false;
  const fail=error=>{for(const waiter of pending.values())waiter.reject(error);pending.clear();};
  worker.onmessage=({data})=>{const waiter=pending.get(data.id);if(!waiter)return;pending.delete(data.id);data.error?waiter.reject(new Error(data.error)):waiter.resolve(data.result);};
  worker.onerror=event=>fail(new Error(event.message || 'Не удалось декодировать GIF'));
  const call=(type,payload={},transfer=[])=>{
    if(closed)return Promise.reject(new Error('GIF closed'));
    const id=++next;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});worker.postMessage({id,type,...payload},transfer);});
  };
  return {init:async blob=>{const bytes=await blob.arrayBuffer();return call('init',{bytes},[bytes]);},frame:index=>call('frame',{index}),close(){closed=true;worker.terminate();fail(new Error('GIF closed'));}};
}
export function createGifCompositor({element,width,height,background=null,createCanvas=()=>document.createElement('canvas')}) {
  const ctx=element.getContext('2d'),patch=createCanvas(1,1),backup=createCanvas(width,height);
  patch.width=1;patch.height=1;backup.width=width;backup.height=height;
  let previous=null;
  const clear=(x=0,y=0,w=width,h=height)=>{
    ctx.clearRect(x,y,w,h);
    if(background){ctx.fillStyle=`rgb(${background.join(',')})`;ctx.fillRect(x,y,w,h);}
  };
  clear();
  return {
    draw(frame){
      if(previous?.disposalType===2){const d=previous.dims;clear(d.left,d.top,d.width,d.height);}
      if(previous?.disposalType===3){ctx.clearRect(0,0,width,height);ctx.drawImage(backup,0,0);}
      if(frame.disposalType===3){const b=backup.getContext('2d');b.clearRect(0,0,width,height);b.drawImage(element,0,0);}
      const d=frame.dims;patch.width=d.width;patch.height=d.height;
      const pctx=patch.getContext('2d');const data=pctx.createImageData(d.width,d.height);data.data.set(frame.patch);pctx.putImageData(data,0,0);
      ctx.drawImage(patch,d.left,d.top);previous={dims:d,disposalType:frame.disposalType};
    },
    reset(){previous=null;clear();},
    dispose(){patch.width=0;patch.height=0;backup.width=0;backup.height=0;},
  };
}
export async function createGifMedia({blob,budget,decoder=createWorkerDecoder(),createCanvas=()=>document.createElement('canvas')}={}) {
  const key=`gif-${Math.random()}`;
  let disposed=false,compositor,element,meta;
  const dispose=()=>{if(disposed)return;disposed=true;decoder.close();compositor?.dispose();if(element){element.width=0;element.height=0;}budget.remove(key);};
  try {
    budget.reserve(key,blob.size*2,()=>dispose(),{pinned:true});
    meta=await decoder.init(blob);
    budget.resize(key,meta.width*meta.height*32+blob.size*2);
  }catch(error){dispose();throw error;}
  const {width,height,frameCount,loops,background}=meta;
  try {
    element=createCanvas(width,height);element.width=width;element.height=height;
    compositor=createGifCompositor({element,width,height,background,createCanvas});
  }catch(error){dispose();throw error;}
  let index=0,cycle=1,deadline=null,delay=100;
  try{const first=await decoder.frame(0);compositor.draw(first);delay=first.delay;}catch(error){dispose();throw error;}
  return {
    element,width,height,
    async advance(now){
      if(disposed)return {changed:false,nextDelayMs:null};
      if(deadline===null){deadline=now+delay;return {changed:false,nextDelayMs:delay};}
      if(now<deadline)return {changed:false,nextDelayMs:deadline-now};
      if(index+1===frameCount){
        if(cycle>=loops)return {changed:false,nextDelayMs:null};
        index=0;cycle++;compositor.reset();
      }else index++;
      const frame=await decoder.frame(index);if(disposed)return {changed:false,nextDelayMs:null};
      compositor.draw(frame);delay=frame.delay;deadline=now+delay;
      return {changed:true,nextDelayMs:delay};
    },
    restart(){deadline=null;},
    dispose,
  };
}
