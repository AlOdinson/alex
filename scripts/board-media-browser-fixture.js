import { Canvas, FabricImage, FabricObject, Rect, util } from 'fabric';
import { createBoardMediaRuntime, MEDIA_OBJECT_FIELDS } from '../src/lib/boardMediaRuntime.js';
import { createMediaAssetStore } from '../src/lib/mediaAssetStore.js';
import { createMediaAssetTransfer } from '../src/lib/mediaAssetTransfer.js';
import { createPeerDataChannelTransport } from '../src/lib/peerDataChannel.js';
import { pdfPageGeometry } from '../src/lib/pdfPageGeometry.js';
import { renderFabricCanvas } from '../src/lib/exportBoard.js';
FabricObject.customProperties = ['boardObjectId', ...MEDIA_OBJECT_FIELDS];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (ok, message) => { if (!ok) throw new Error(message); };
window.runMediaChecks = async () => {
  const canvas = new Canvas(document.body.appendChild(document.createElement('canvas')), {width:700,height:500});
  const store = createMediaAssetStore();
  const errors=[];
  const runtime = createBoardMediaRuntime({canvas,boardId:'fixture',store,onError:error=>errors.push(error.message)});
  const added=[];
  try {
    for (const [name, kind] of [['pages.pdf','pdf'],['animated.gif','gif']]) {
      const blob=await (await fetch(`./fixtures/media/${name}`)).blob();
      const meta=await store.importFile('fixture',Object.assign(blob,{name}));
      check(meta.persisted,'IndexedDB persistence');
      const prepared=await runtime.prepareAsset(meta);
      const object=new FabricImage(prepared.result.element,{left:100,top:100,scaleX:.5,scaleY:.5,boardObjectId:kind,
        mediaKind:kind,mediaAssetId:meta.assetId,mediaName:name,pageNumber:1,pageCount:prepared.pageCount});
      runtime.adopt(object,prepared);canvas.add(object);added.push(object);
    }
    const [pdf,gif]=added;
    const largeBlob=await (await fetch('./fixtures/media/large.pdf')).blob();
    const largeMeta=await store.importFile('fixture',Object.assign(largeBlob,{name:'large.pdf'}));
    const large=await runtime.prepareAsset(largeMeta);check(large.pageCount===60,'large PDF page count');
    const last=await large.media.renderPage(60,{pixelWidth:10000});check(last.width*last.height<=4000000,'large PDF raster cap');large.media.dispose();
    const copies=await util.enlivenObjects([gif.toObject(),gif.toObject()]);
    copies.forEach((copy,index)=>{copy.set({left:140+index*30});canvas.add(copy);});

    check(pdf.pageCount===2,'real PDF pages');
    const sample=object=>[...object.getElement().getContext('2d').getImageData(2,2,1,1).data].slice(0,3).join(',');
    check(sample(pdf)==='255,0,0','PDF first page pixels');
    const gifColors=new Set(),gifSamples=[];
    for(let i=0;i<30;i++){gifColors.add(sample(gif));gifSamples.push(sample(gif));await sleep(40);}
    check(gifColors.has('255,0,0')&&gifColors.has('0,0,255'),'real animated GIF worker '+JSON.stringify({colors:[...gifColors],errors,stats:runtime.getStats(),onScreen:gif.isOnScreen()}));
    check(gifSamples.filter((value,index)=>index>0&&value!==gifSamples[index-1]).length>=4,'GIF repeats continuously');
    const result=await runtime.preparePage(pdf,2);pdf.set({pageNumber:2,...pdfPageGeometry(pdf,result)});runtime.showPreparedPage(pdf,result);
    check(sample(pdf)==='0,0,255','PDF second page pixels');
    const snapshot=pdf.toObject();check(snapshot.src.length<200&&snapshot.pageNumber===2,'small serialized PDF reference');
    const center=pdf.getCenterPoint();pdf.set({scaleX:.4,scaleY:.6,angle:22});pdf.setPositionByOrigin(center,'center','center');
    const serialized=pdf.toObject();canvas.remove(pdf);
    const [revived]=await util.enlivenObjects([serialized]);canvas.add(revived);
    for(let i=0;i<100 && sampleSafe(revived)!=='0,0,255';i++)await sleep(30);
    check(sampleSafe(revived)==='0,0,255'&&revived.pageNumber===2,'undo/reload hydration');
    check(revived.angle===22&&revived.scaleY===.6,'geometry recovery');
    canvas.renderAll();const exported=renderFabricCanvas(canvas,'blank',{multiplier:1});
    check(exported.width===700&&exported.height===500,'export current live pixels');
    const exportContext=exported.getContext('2d');
    check([...exportContext.getImageData(200,100,1,1).data].slice(0,3).join(',')==='0,0,255','export shows current PDF page '+JSON.stringify({pixel:[...exportContext.getImageData(200,100,1,1).data],center:revived.getCenterPoint(),bounds:revived.getBoundingRect(),dims:[revived.width,revived.height],element:[revived.getElement().width,revived.getElement().height]}));
    check([...exportContext.getImageData(699,499,1,1).data].join(',')==='255,255,255,255','export uses white background');
    // Separate logical room, separate bytes: exercise the same peer transfer protocol.
    const remoteStore=createMediaAssetStore({indexedDB:{open:(name,version)=>indexedDB.open(name+'-remote',version)}});
    let testedWebRtc=false;
    if(window.MEDIA_SKIP_WEBRTC){
      let a,b;
      a=createMediaAssetTransfer({boardId:'fixture',store,send:(type,payload)=>b.handleMessage({type,payload})});
      b=createMediaAssetTransfer({boardId:'fixture',store:remoteStore,send:(type,payload)=>a.handleMessage({type,payload})});
      const received=await b.request(revived.mediaAssetId);check(received.metadata.assetId===revived.mediaAssetId,'peer media protocol');a.close();b.close();
    }else{
    const pcA=new RTCPeerConnection({iceServers:[]}),pcB=new RTCPeerConnection({iceServers:[]});
    const iceA=[],iceB=[];
    pcA.onicecandidate=({candidate})=>{if(candidate){if(pcB.remoteDescription)pcB.addIceCandidate(candidate);else iceA.push(candidate);}};
    pcB.onicecandidate=({candidate})=>{if(candidate){if(pcA.remoteDescription)pcA.addIceCandidate(candidate);else iceB.push(candidate);}};
    const channelA=pcA.createDataChannel('board');let channelB;
    const receivedChannel=new Promise(ok=>pcB.ondatachannel=event=>{channelB=event.channel;ok();});
    await pcA.setLocalDescription(await pcA.createOffer());await pcB.setRemoteDescription(pcA.localDescription);
    for(const candidate of iceA)await pcB.addIceCandidate(candidate);
    await pcB.setLocalDescription(await pcB.createAnswer());await pcA.setRemoteDescription(pcB.localDescription);
    for(const candidate of iceB)await pcA.addIceCandidate(candidate);
    await Promise.race([receivedChannel,sleep(10000).then(()=>{throw new Error('WebRTC channel negotiation timed out: '+JSON.stringify({a:pcA.iceConnectionState,b:pcB.iceConnectionState,iceA:iceA.length,iceB:iceB.length}));})]);
    for(let i=0;i<100&&channelA.readyState!=='open';i++)await sleep(100);
    check(channelA.readyState==='open','real WebRTC channel connected');
    let a,b;
    const transportA=createPeerDataChannelTransport({channel:channelA,onMessage:message=>a.handleMessage(message)});
    const transportB=createPeerDataChannelTransport({channel:channelB,onMessage:message=>b.handleMessage(message)});
    a=createMediaAssetTransfer({boardId:'fixture',store,send:(type,payload)=>transportA.sendLowPriorityEncoded(JSON.stringify({v:1,type,payload}))});
    b=createMediaAssetTransfer({boardId:'fixture',store:remoteStore,send:(type,payload)=>transportB.sendLowPriorityEncoded(JSON.stringify({v:1,type,payload}))});
    const received=await b.request(revived.mediaAssetId);check(received.metadata.assetId===revived.mediaAssetId,'peer media request');
    a.close();b.close();transportA.close();transportB.close();pcA.close();pcB.close();
    testedWebRtc=true;
    }
    for(let i=0;i<1000;i++)canvas.add(new Rect({width:2,height:2,left:i%600,top:i%400,fill:'#111'}));
    const started=performance.now();for(let i=0;i<5;i++)canvas.renderAll();
    const renderMs=(performance.now()-started)/5;
    check(errors.length===0,errors.join(';'));
    return {pdfPages:2,gifColors:[...gifColors],recovery:true,peerTransfer:true,webRtc:testedWebRtc,objects:canvas.size(),renderMs,memoryBytes:runtime.getStats().memoryBytes};
  } finally {runtime.dispose();canvas.dispose();}
};
function sampleSafe(object){try{return [...object.getElement().getContext('2d').getImageData(2,2,1,1).data].slice(0,3).join(',');}catch{return '';}}
