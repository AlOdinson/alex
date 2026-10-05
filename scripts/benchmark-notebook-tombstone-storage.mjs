// Logical values handed to IndexedDB, NOT physical disk I/O or pen latency.
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { createAuthorityBoard, persistAuthorityCommit } from '../src/lib/browserAuthorityStore.js';
Object.assign(globalThis,{IDBKeyRange});
const results=[];
for(const count of [0,300,1800,6000,10000]) {
 globalThis.indexedDB=new IDBFactory();
 const tombstones=Object.fromEntries(Array.from({length:count},(_,i)=>[`old-${i}`,{clientId:'writer',actionId:`deleted-${i}`,mutationId:`m-${i}`,revision:i}]));
 await createAuthorityBoard({boardId:'benchmark',createdAt:1,snapshot:{version:2,background:'blank',canvas:{objects:[]}},tombstones});
 const writes=[],put=IDBObjectStore.prototype.put,add=IDBObjectStore.prototype.add;
 const wrap=(method,original)=>function(value,...args){writes.push({method,store:this.name,bytes:new TextEncoder().encode(JSON.stringify(value)).length});return original.call(this,value,...args);};
 IDBObjectStore.prototype.put=wrap('put',put);IDBObjectStore.prototype.add=wrap('add',add);
 try{await persistAuthorityCommit('benchmark',{actionId:'next',clientId:'writer',revision:1,committedAt:2,ops:[{type:'delete',id:'source-next',mutationId:'mutation-next'}]});}
 finally{IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.add=add;}
 results.push({priorDeletions:count,logicalWriteBytes:writes.reduce((n,w)=>n+w.bytes,0),writes});
}
console.log(JSON.stringify({node:process.version,scope:'One commit after setup; JSON UTF-8 byte lengths of values supplied to IndexedDB, not disk bytes or timing',results},null,2));
