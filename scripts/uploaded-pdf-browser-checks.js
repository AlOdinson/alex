import { createMediaAssetStore } from '../src/lib/mediaAssetStore.js';
import { createMediaAssetTransfer } from '../src/lib/mediaAssetTransfer.js';
import { createPeerDataChannelTransport } from '../src/lib/peerDataChannel.js';
import { createBoardMediaRuntime } from '../src/lib/boardMediaRuntime.js';
import { Canvas, FabricImage } from 'fabric';

// Optional local attachment only. The user's PDF is never part of the repository.
export async function runUploadedPdfChecks(file) {
  const check=(value,message)=>{if(!value)throw new Error(message);};
  const makeStore=suffix=>createMediaAssetStore({indexedDB:{open:(name,version)=>indexedDB.open(name+suffix,version)}});
  const source=makeStore('-book-source'),receiver=makeStore('-book-receiver');
  const book=await source.importFile('book-test',file);
  const small=await source.importFile('book-test',new File([await (await fetch('./fixtures/media/pages.pdf')).blob()],'small.pdf'));
  let frames=0,lateControls=0,ready=0;const errors=[],progress=[];
  class Channel extends EventTarget {
    readyState='open';bufferedAmount=0;
    send(data){frames++;queueMicrotask(()=>this.other.dispatchEvent(new MessageEvent('message',{data})));}
  }
  const channelA=new Channel(),channelB=new Channel();channelA.other=channelB;channelB.other=channelA;
  let a,b;
  const transportA=createPeerDataChannelTransport({channel:channelA,onMessage:message=>a.handleMessage(message).catch(error=>errors.push(error.message)),onError:error=>errors.push(error.message)});
  const transportB=createPeerDataChannelTransport({channel:channelB,onMessage:message=>{if(message.type==='head'){lateControls++;return;}b.handleMessage(message).catch(error=>errors.push(error.message));},onError:error=>errors.push(error.message)});
  a=createMediaAssetTransfer({boardId:'book-test',store:source,send:(type,payload)=>transportA.sendMediaEncoded(JSON.stringify({v:1,type,payload}))});
  b=createMediaAssetTransfer({boardId:'book-test',store:receiver,send:(type,payload)=>transportB.sendMediaEncoded(JSON.stringify({v:1,type,payload}))});
  const canvas=new Canvas(document.body.appendChild(document.createElement('canvas')),{width:700,height:500});
  let runtime;
  const started=performance.now();
  const control=setInterval(()=>transportA.send('head',{revision:0}).catch(()=>{}),250);
  try {
    runtime=createBoardMediaRuntime({canvas,boardId:'book-test',store:receiver,
      requestAsset:(id,options)=>b.request(id,options),onReady:()=>ready++,onError:error=>errors.push(error.message),
      onStatusChange:()=>{for(const state of runtime?.getLoadStates()||[])if(state.object.mediaAssetId===book.assetId&&state.total)progress.push(Math.floor(state.loaded*100/state.total));}});
    for(const [index,asset] of [book,small].entries()){
      const element=document.createElement('canvas');element.width=1;element.height=1;
      canvas.add(new FabricImage(element,{left:index*320,top:0,width:505,height:758,scaleX:.5,scaleY:.5,
        mediaKind:'pdf',mediaAssetId:asset.assetId,mediaName:asset.name,pageNumber:1}));
    }
    const deadline=performance.now()+180000;
    while(ready<2&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
    check(ready>=2,`PDFs not ready: ${JSON.stringify({errors,states:runtime.getLoadStates().map(({phase,loaded,total})=>({phase,loaded,total}))})}`);
    const object=canvas.getObjects()[0];const element=object.getElement();
    check(element.width>1&&element.height>1,'received PDF has rendered pixels');
    check(element.getContext('2d').getImageData(10,10,1,1).data[3]>0,'received PDF cover is not transparent');
    check(progress.some(value=>value>0&&value<100)&&progress.includes(100),'download progress visible');
    check(lateControls>0,'interactive messages flow during media transfer');
    check(frames<Math.ceil(file.size/8192)*2+1000,'media not nested in 13-frame transfers');
    check(errors.length===0,errors.join('; '));
    return {fileBytes:file.size,bothPdfsRendered:true,frames,interactiveMessages:lateControls,elapsedSeconds:Math.round((performance.now()-started)/1000),progressEvents:progress.length};
  }finally{clearInterval(control);runtime?.dispose();canvas.dispose();a.close();b.close();transportA.close();transportB.close();source.dispose();receiver.dispose();}
}
