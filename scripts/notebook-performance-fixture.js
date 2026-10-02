import { Path, FabricImage, util } from 'fabric';
import { BoardNotebook } from '../src/lib/boardNotebook.js';
import { createConditionalRecordPatchOps } from '../src/lib/operationProtocol.js';

export const makeStroke = (i) => new Path(Array.from({ length: 40 }, (_, k) => [k ? 'L' : 'M', -220 + k * 5, -200 + (i % 45) * 8 + Math.sin(k) * 3]), { stroke: 'black', strokeWidth: 2, fill: null, boardObjectId: `stroke-${i}` });
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
const percentile = (samples, fraction) => [...samples].sort((a,b)=>a-b)[Math.ceil(samples.length * fraction) - 1];

export async function benchmarkNotebooks() {
  const original = Path.prototype.toObject;
  let visits = 0;
  Path.prototype.toObject = function(...args) { visits++; return original.apply(this,args); };
  const results = [];
  try {
    for (const strokes of [100,300]) for (const pages of [1,6,12,20]) {
      const samples = Array.from({length:strokes}, (_,i)=>makeStroke(i).toObject(['boardObjectId']));
      const times = [], observations = [];
      for (let repeat = -1; repeat < 5; repeat++) {
        visits=0;
        const book=await BoardNotebook.fromObject({width:520,height:480,boardObjectId:'book',notebookPages:Array.from({length:pages},()=>structuredClone(samples)),notebookPageNumber:pages});
        const hydrationVisits=visits;
        visits=0;
        const started=performance.now();
        const before=[{object:book.toObject(['boardObjectId']),zIndex:0}];
        book.addPageObject(makeStroke(strokes));
        const after=[{object:book.toObject(['boardObjectId']),zIndex:0}];
        const forward=createConditionalRecordPatchOps(before,after), inverse=createConditionalRecordPatchOps(after,before);
        const duration=performance.now()-started;
        if(repeat>=0) { times.push(duration);observations.push({forwardBytes:bytes(forward),inverseBytes:bytes(inverse),childSerializationVisits:visits,hydrationVisits}); }
        book.dispose();
      }
      results.push({scenario:{pages,strokes,points:40},strokePreparationP50Ms:percentile(times,.5),strokePreparationP95Ms:percentile(times,.95),...observations[0],pageHydrations:1,fullSceneRenders:null,cacheBytes:null,pendingActions:0,convergence:null});
    }
    const surface=document.createElement('canvas');surface.width=1024;surface.height=768;
    surface.getContext('2d').fillRect(0,0,1024,768);
    const image=new FabricImage(surface,{left:-100,top:-100,width:200,height:160,boardObjectId:'image'});
    const book=new BoardNotebook();book.addPageObject(image);
    const imageBefore=book.toObject();visits=0;
    let encodes=0;const encode=surface.toDataURL;surface.toDataURL=function(...args){encodes++;return encode.apply(this,args);};
    for(let i=0;i<100;i++) {book.addPageObject(makeStroke(i));book.toObject();}
    results.push({scenario:{images:1,strokes:100},imageEncodes:encodes,childSerializationVisits:visits,inlineImageBytes:bytes(imageBefore)});
    book.dispose();
    return {environment:{browser:navigator.userAgent,dpr:devicePixelRatio,hardwareConcurrency:navigator.hardwareConcurrency,video:'none (stroke-only benchmark)'},results};
  } finally {Path.prototype.toObject=original;}
}

export async function benchmarkReceivedNotebookVideo({width=1920,height=1080,fps=60}={}) {
  const {Canvas}=await import('fabric');
  const {createBrowserPeerConnection}=await import('../src/lib/browserPeerConnection.js');
  const {createBoardScreenShareMedia}=await import('../src/lib/boardScreenShare.js');
  const source=document.createElement('canvas');source.width=width;source.height=height;
  const ctx=source.getContext('2d');
  let count=0;
  const paint=()=>{ctx.fillStyle=count++%2?'#3a55da':'#ee9877';ctx.fillRect(0,0,width,height);ctx.fillStyle='#000';ctx.fillRect(count%width,0,100,height);};
  paint();
  const stream=source.captureStream(fps),timer=setInterval(paint,1000/fps);
  const errors=[];let sender,receiver;
  const options={rtcConfig:{iceServers:[],iceCandidatePoolSize:0},onError:e=>errors.push(e.message)};
  sender=createBrowserPeerConnection({...options,initiator:true,sendSignal:s=>{queueMicrotask(()=>receiver.handleSignal(s).catch(e=>errors.push(e.message)));}});
  receiver=createBrowserPeerConnection({...options,sendSignal:s=>{queueMicrotask(()=>sender.handleSignal(s).catch(e=>errors.push(e.message)));}});
  const received=new Promise(resolve=>receiver.getPeerConnection().ontrack=e=>resolve(e.streams[0]||new MediaStream([e.track])));
  sender.getPeerConnection().addTrack(stream.getVideoTracks()[0],stream);
  const canvas=new Canvas(document.createElement('canvas'),{width:1000,height:800,renderOnAddRemove:false,enableRetinaScaling:true,preserveObjectStacking:true});
  document.body.append(canvas.wrapperEl);
  const media=createBoardScreenShareMedia({sessionId:'notebook-perf',layout:{left:0,top:0,width:640,height:360}});
  const sample=Array.from({length:100},(_,i)=>makeStroke(i).toObject(['boardObjectId']));
  const book=await BoardNotebook.fromObject({left:200,top:200,notebookPages:Array.from({length:6},()=>structuredClone(sample)),notebookPageNumber:6});
  canvas.add(media.object,book);canvas.setActiveObject(book);
  const eraser=makeStroke(50);eraser.globalCompositeOperation='destination-out';book.addPageObject(eraser);
  let videoTimeout;
  try {
    await sender.start();
    media.setStream(await Promise.race([received,new Promise((_,reject)=>{videoTimeout=setTimeout(()=>reject(Error('No received WebRTC stream')),15000);})]));
    const waitFrames=frames=>new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error(`Timed out receiving ${frames} frames (${errors}); sender=${sender.getPeerConnection().connectionState}, receiver=${receiver.getPeerConnection().connectionState}, ready=${media.video.readyState}, size=${media.video.videoWidth}x${media.video.videoHeight}, tracks=${media.video.srcObject?.getTracks().map(t=>`${t.readyState}/${t.muted}`)}, gathering=${sender.getPeerConnection().iceGatheringState}`)),15000);
      let n=0;const next=()=>{if(++n>=frames){clearTimeout(timeout);resolve();}else media.video.requestVideoFrameCallback(next);};
      media.video.requestVideoFrameCallback(next);
    });
    await waitFrames(8);canvas.cancelRequestedRender();canvas.renderAll();
    let fullSceneRenders=0;canvas.on('before:render',()=>fullSceneRenders++);
    const started=performance.now();await waitFrames(60);const durationMs=performance.now()-started;
    const steadyFullSceneRenders=fullSceneRenders;
    const strokeTimes=[];
    for(let i=0;i<300;i++) {
      const started=performance.now();book.addPageObject(makeStroke(1000+i));strokeTimes.push(performance.now()-started);
      canvas.requestRenderAll();
      if(i%10===0)await new Promise(resolve=>setTimeout(resolve,0));
    }
    await waitFrames(5);
    const stats=await receiver.getPeerConnection().getStats();
    const inbound=[...stats.values()].find(s=>s.type==='inbound-rtp'&&(s.kind==='video'||s.mediaType==='video'));
    return {environment:{browser:navigator.userAgent,dpr:devicePixelRatio,video:{width,height,fps},transport:'real canvas MediaStream through createBrowserPeerConnection'},scenario:{pages:6,strokes:100,addedStrokes:300,selected:true,eraser:true},frames:60,durationMs,fullSceneRenders:steadyFullSceneRenders,strokePreparationP50Ms:percentile(strokeTimes,.5),strokePreparationP95Ms:percentile(strokeTimes,.95),visibleObjects:book.getPageObjects().length,received:{framesDecoded:inbound?.framesDecoded,frameWidth:inbound?.frameWidth,frameHeight:inbound?.frameHeight,totalDecodeTime:inbound?.totalDecodeTime},errors};
  } finally {clearTimeout(videoTimeout);clearInterval(timer);stream.getTracks().forEach(t=>t.stop());sender.close();receiver.close();media.dispose();await canvas.dispose();}
}
