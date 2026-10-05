import test from 'node:test';import assert from 'node:assert/strict';
import {getEnv} from 'fabric/node';import {setEnv,Path,StaticCanvas,Shadow} from 'fabric';
import {BoardNotebook} from '../src/lib/boardNotebook.js';setEnv(getEnv());
test('a notebook with an offset child shadow keeps the cache required by its page clip',async()=>{
 const canvas=new StaticCanvas(null,{width:600,height:600,renderOnAddRemove:false});const book=new BoardNotebook({boardObjectId:'shadow-book'});
 book.addPageObject(new Path('M 0 0 L 15 9',{boardObjectId:'shadow-ink',stroke:'black',shadow:new Shadow({offsetX:10,offsetY:3,blur:5})}));canvas.add(book);
 try{assert.doesNotThrow(()=>canvas.renderAll());assert.equal(book.ownCaching,true);assert.ok(book._cacheCanvas);}finally{await canvas.dispose();}
});
