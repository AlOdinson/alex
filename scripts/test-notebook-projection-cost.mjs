import test from 'node:test';
import assert from 'node:assert/strict';
import {getEnv} from 'fabric/node';
import {setEnv,Rect} from 'fabric';
import {BoardNotebook} from '../src/lib/boardNotebook.js';
import {prepareNotebookProjection} from '../src/lib/notebookProjection.js';
setEnv(getEnv());
const child=id=>({...new Rect({width:20,height:20,left:-40,top:-40}).toObject(),boardObjectId:id});

test('identical page reference never reads the Fabric child list on metadata acknowledgement',async()=>{
 const book=await BoardNotebook.fromObject({boardObjectId:'book',notebookPageNumber:1,notebookPages:[[child('a')]]});
 const target={...book.toObject(['boardObjectId']),updatedAt:99,updatedBy:'owner'};
 book.dirty=false;
 const original=book.getPageObjects;
 let reads=0;
 book.getPageObjects=()=>{reads++;return original.call(book);};
 try {
  const work=await prepareNotebookProjection(book,target);assert.equal(work.apply(),true);
  assert.equal(reads,0,'unchanged page walked Fabric children');assert.equal(book.dirty,false);
  assert.equal(book.updatedAt,99);assert.equal(book.updatedBy,'owner');
 }finally{book.getPageObjects=original;book.dispose();}
});

test('adding one record does not enumerate fields of shared unchanged records',async()=>{
 const book=await BoardNotebook.fromObject({boardObjectId:'book',notebookPageNumber:1,notebookPages:[[child('a'),child('b')]]});
 const originalChildren=book.getPageObjects();let fieldsRead=0;
 const shared=book.notebookPages[0].map(record=>new Proxy(record,{ownKeys(target){fieldsRead++;return Reflect.ownKeys(target);}}));
 book.notebookPages=[shared];
 const target={...book.toObject(['boardObjectId']),notebookPages:[[...shared,child('c')]]};
 try {
  const work=await prepareNotebookProjection(book,target);assert.equal(work.apply(),true);
  assert.equal(fieldsRead,0,'projection spread unchanged records just to compare them');
  assert.strictEqual(book.getPageObjects()[0],originalChildren[0]);
  assert.strictEqual(book.getPageObjects()[1],originalChildren[1]);
  assert.equal(book.getPageObjects().length,3);
 }finally{book.dispose();}
});
