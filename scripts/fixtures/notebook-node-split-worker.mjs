import {parentPort} from 'node:worker_threads';
globalThis.self={postMessage:value=>parentPort.postMessage(value)};
await import('../../src/lib/notebookSplitWorker.js');
parentPort.on('message',data=>self.onmessage({data}));
