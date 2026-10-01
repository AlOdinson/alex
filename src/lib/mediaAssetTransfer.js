import { validateMediaMetadata, mediaKindFromBytes } from './mediaAssetStore.js';
const CHUNK_BYTES=8192;
export const isMediaMessage = message => String(message?.type || '').startsWith('asset-');
const toBase64=bytes=> { let text=''; for(const b of bytes)text+=String.fromCharCode(b); return btoa(text); };
const fromBase64=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
export function createMediaAssetTransfer({boardId,store,send,canUpload=async()=>true,onError=()=>{},timeoutMs=120_000}={}) {
  const incoming=new Map(),waiters=new Map(),confirmed=new Set(),uploads=new Map(),requests=new Map();
  let closed=false;
  const id=()=>globalThis.crypto?.randomUUID?.() || `media-${Date.now()}-${Math.random()}`;
  const wait=(key)=>{
    let resolve,reject;
    const promise=new Promise((ok,no)=>{resolve=ok;reject=no;});
    // Sending can fail before the caller awaits this promise.
    promise.catch(()=>{});
    const timer=setTimeout(()=>finish(key,null,new Error('Передача медиафайла не завершилась вовремя')),timeoutMs);
    waiters.set(key,{resolve,reject,timer}); return promise;
  };
  const finish=(key,value,error)=>{
    const w=waiters.get(key); if(!w)return;
    waiters.delete(key);clearTimeout(w.timer);error?w.reject(error):w.resolve(value);
  };
  const emit=(type,payload)=>{
    if(closed)return Promise.reject(new Error('Media transfer closed'));
    return send(type,{...payload,boardId});
  };
  const drop=(transferId)=>{const state=incoming.get(transferId);clearTimeout(state?.timer);incoming.delete(transferId);};
  const upload=async(assetId,transferId=id())=>{
    const record=await store.get(boardId,assetId);
    if(closed)throw new Error('Media transfer closed');
    if(!record)throw new Error('Медиафайл отсутствует');
    const ready=wait(`${transferId}:ready`),complete=wait(`${transferId}:complete`);
    try {
      await emit('asset-start',{transferId,assetId,metadata:record.metadata,totalChunks:Math.ceil(record.blob.size/CHUNK_BYTES)});
      const status=await ready;
      if(status!=='complete') {
        for(let offset=0,index=0;offset<record.blob.size;offset+=CHUNK_BYTES,index++){
          const bytes=new Uint8Array(await record.blob.slice(offset,offset+CHUNK_BYTES).arrayBuffer());
          await emit('asset-chunk',{transferId,assetId,index,base64Chunk:toBase64(bytes)});
          await new Promise(resolve=>setTimeout(resolve,0));
        }
        await emit('asset-end',{transferId,assetId});
      }
      await complete;confirmed.add(assetId);
    }catch(error){finish(`${transferId}:ready`,null,error);finish(`${transferId}:complete`,null,error);throw error;}
  };
  const api={
    async ensureRemote(assetId){
      if(closed)throw new Error('Media transfer closed');
      if(confirmed.has(assetId))return;
      if(!uploads.has(assetId))uploads.set(assetId,upload(assetId).finally(()=>uploads.delete(assetId)));
      return uploads.get(assetId);
    },
    async request(assetId){
      if(closed)throw new Error('Media transfer closed');
      const existing=await store.get(boardId,assetId);
      if(closed)throw new Error('Media transfer closed');
      if(existing)return existing;
      if(!requests.has(assetId)) {
        const transferId=id();const result=wait(`${transferId}:request`);
        requests.set(assetId,result.finally(()=>requests.delete(assetId)));
        emit('asset-request',{assetId,transferId}).catch(error=>finish(`${transferId}:request`,null,error));
      }
      return requests.get(assetId);
    },
    async handleMessage(message){
      if(closed || !isMediaMessage(message))return false;
      const p=message.payload||{}, transferId=String(p.transferId||'');
      if(p.boardId!==boardId || !/^[a-f0-9]{64}$/.test(p.assetId) || !transferId || transferId.length>100)return false;
      const result=(status,error)=>emit('asset-result',{transferId,assetId:p.assetId,status,error});
      try {
        if(message.type==='asset-result'){
          const error=p.error?new Error(p.error):null;
          if(error){finish(`${transferId}:ready`,null,error);finish(`${transferId}:complete`,null,error);finish(`${transferId}:request`,null,error);}
          else {finish(`${transferId}:ready`,p.status);if(p.status==='complete')finish(`${transferId}:complete`,true);}
          return true;
        }
        if(message.type==='asset-request'){
          // Never disclose a file unless it belongs to the current room.
          upload(p.assetId,transferId).catch(error=>result('error',error.message).catch(onError));
          return true;
        }
        if(message.type==='asset-start'){
          validateMediaMetadata(p.metadata);
          if(p.metadata.assetId!==p.assetId || p.totalChunks!==Math.ceil(p.metadata.size/CHUNK_BYTES))throw new Error('Некорректный размер передачи');
          if(!(await canUpload(p)))throw new Error('Нет прав редактирования для загрузки файла');
          const existing=await store.get(boardId,p.assetId);
          if(existing?.persisted===false)throw new Error('Не удалось сохранить медиафайл на устройстве');
          if(existing){await result('complete');return true;}
          if(incoming.has(transferId) || incoming.size>=2)throw new Error('Слишком много одновременных файлов');
          const state={metadata:p.metadata,parts:[],size:0,totalChunks:p.totalChunks,timer:null};
          state.timer=setTimeout(()=>{drop(transferId);result('error','Передача файла прервана').catch(onError);},timeoutMs);
          incoming.set(transferId,state);await result('ready');return true;
        }
        const state=incoming.get(transferId);
        if(!state || state.metadata.assetId!==p.assetId)throw new Error('Передача файла не начата');
        if(message.type==='asset-chunk'){
          if(p.index!==state.parts.length || p.index>=state.totalChunks || typeof p.base64Chunk!=='string' || p.base64Chunk.length>10924)throw new Error('Некорректная часть файла');
          const bytes=fromBase64(p.base64Chunk);state.size+=bytes.length;
          if(bytes.length>CHUNK_BYTES || state.size>state.metadata.size)throw new Error('Размер файла превышен');
          state.parts.push(bytes);return true;
        }
        if(message.type==='asset-end'){
          if(state.parts.length!==state.totalChunks || state.size!==state.metadata.size)throw new Error('Медиафайл получен не полностью');
          const blob=Object.assign(new Blob(state.parts,{type:state.metadata.mime}),{name:state.metadata.name});
          // Verify before registering bytes in this room.
          const hash=await globalThis.crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
          const actual=[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');
          if(actual!==p.assetId)throw new Error('Проверка целостности файла не пройдена');
          if(mediaKindFromBytes(new Uint8Array(await blob.slice(0,8).arrayBuffer()))!==state.metadata.kind)throw new Error('Формат файла не совпадает');
          const metadata=await store.importFile(boardId,blob);
          if(metadata.persisted===false)throw new Error('Не удалось сохранить медиафайл на устройстве');
          if(metadata.kind!==state.metadata.kind)throw new Error('Формат файла не совпадает');
          drop(transferId);finish(`${transferId}:request`,await store.get(boardId,p.assetId));
          await result('complete');return true;
        }
      }catch(error){drop(transferId);finish(`${transferId}:request`,null,error);await result('error',error.message);onError(error);}
      return true;
    },
    close(){closed=true;for(const key of [...waiters.keys()])finish(key,null,new Error('Media transfer closed'));for(const key of [...incoming.keys()])drop(key);confirmed.clear();},
  };
  return api;
}
