import React,{useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Canvas} from 'fabric';
import {useAdaptiveScreenShare} from '../src/components/ScreenShare.jsx';
import {createBoardScreenShareMedia} from '../src/lib/boardScreenShare.js';

// Diagnostic only: real production hooks and rendering, generated capture,
// two separate pages and native WebRTC; no external services or user board data.
export function install(role) {
  const state=window.diag={role,peers:[],constraints:[],encodings:[],signals:[],errors:[],frameCallbacks:0,boardRenders:0,frameCopies:0};
  const NativePeer=window.RTCPeerConnection;
  window.RTCPeerConnection=class extends NativePeer{constructor(){super({iceServers:[]});state.peers.push(this);}};
  const nativeSet=RTCRtpSender.prototype.setParameters;
  RTCRtpSender.prototype.setParameters=async function(p){
    const entry={time:performance.now(),requested:p.encodings};state.encodings.push(entry);
    try{const result=await nativeSet.call(this,p);entry.actual=this.getParameters().encodings;return result;}
    catch(e){entry.error=e.name+': '+e.message;throw e;}
  };
  const capture=async()=>{
    const source=document.createElement('canvas');source.width=1920;source.height=1080;
    const ctx=source.getContext('2d');let n=0;
    function paint(){ctx.fillStyle=(n++%2)?'#bc2040':'#1647ce';ctx.fillRect(0,0,1920,1080);ctx.fillStyle='#ffffff';ctx.fillRect((n*11)%1800,0,75,1080);}
    paint();state.timer=setInterval(paint,1000/60);state.source=source;
    const stream=source.captureStream(60);state.capture=stream;
    const track=stream.getVideoTracks()[0],nativeApply=track.applyConstraints.bind(track);
    track.applyConstraints=async p=>{const entry={time:performance.now(),p};state.constraints.push(entry);try{await nativeApply(p);entry.settings=track.getSettings();}catch(e){entry.error=e.name+': '+e.message;throw e;}};
    return stream;
  };
  navigator.mediaDevices.getDisplayMedia=capture;
  const clientId=role==='host'?'diagnostic-host':'diagnostic-viewer';
  const users=[{clientId:'diagnostic-host',name:'Host',permission:'owner'},{clientId:'diagnostic-viewer',name:'Viewer',permission:'edit'}];
  const realtimeRef={current:{sendScreenShareSignal:payload=>{
    const message={...payload,clientId,name:role,permission:role==='host'?'owner':'edit',timestamp:Date.now()};
    state.signals.push({type:payload.type,time:performance.now()});
    return window.routeSignal(message);
  }}};
  const element=document.createElement('canvas');document.body.append(element);
  const canvas=new Canvas(element,{width:1000,height:800,renderOnAddRemove:true,preserveObjectStacking:true});state.canvas=canvas;
  function Probe(){
    const share=useAdaptiveScreenShare({realtimeRef,users,isOwner:role==='host',canEdit:true,clientId,participantName:role,boardId:'diagnostic-board',boardKey:'diagnostic-key',boardRealtimeKey:'',teacherAccountKey:'',getInitialBoardLayout:()=>({left:40,top:40,width:640,height:360})});
    state.share=share;
    useEffect(()=>{
      if(!share.sessionId||share.sourceMode!=='screen')return;
      if(!state.media){
        state.media=createBoardScreenShareMedia({sessionId:share.sessionId,layout:share.boardLayout,canEdit:true});canvas.add(state.media.object);
        const v=state.media.video,callback=v.requestVideoFrameCallback.bind(v);
        v.requestVideoFrameCallback=fn=>callback((...a)=>{state.frameCallbacks++;return fn(...a);});
        const object=state.media.object,render=object.render.bind(object);object.render=(...a)=>{state.boardRenders++;return render(...a);};
        const ctx=state.media.frameCanvas.getContext('2d'),draw=ctx.drawImage.bind(ctx);ctx.drawImage=(...a)=>{state.frameCopies++;return draw(...a);};
      }
      state.media.setStream(share.stream);canvas.requestRenderAll();
    },[share.sessionId,share.stream]);
    return null;
  }
  const rootEl=document.createElement('div');document.body.append(rootEl);state.root=createRoot(rootEl);state.root.render(<Probe/>);
  state.receive=message=>state.share?.handleSignal(message);
  state.sample=async()=>{
    const stats=[];
    for(const p of state.peers){if(p.connectionState==='closed')continue;stats.push({connection:p.connectionState,senders:p.getSenders().map(s=>s.getParameters()),rtp:[...((await p.getStats()).values())].filter(s=>['outbound-rtp','inbound-rtp','media-source','candidate-pair'].includes(s.type))});}
    return {time:performance.now(),phase:state.share.phase,profile:state.share.profileId,ultra:state.share.ultraEnabled,videoReady:state.media?.video?.readyState,frames:state.frameCallbacks,boardRenders:state.boardRenders,frameCopies:state.frameCopies,stats,encodings:state.encodings,constraints:state.constraints,signals:state.signals,errors:state.errors};
  };
  state.close=async()=>{state.share?.stop();clearInterval(state.timer);state.media?.dispose();state.root.unmount();await canvas.dispose();};
}
