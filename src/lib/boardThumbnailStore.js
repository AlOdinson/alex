let database;
function open() {
  if (database) return database;
  database = new Promise((resolve, reject) => {
    const request = indexedDB.open('alex-board-previews', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('images', { keyPath: 'boardId' }).createIndex('updatedAt', 'updatedAt');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Preview storage blocked'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = null; };
      resolve(db);
    };
  }).catch(error => { database = null; throw error; });
  return database;
}
export async function readBoardThumbnail(boardId) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const request = db.transaction('images').objectStore('images').get(boardId);
      request.onsuccess = () => resolve(request.result?.image ?? null);
      request.onerror = () => reject(request.error);
    });
  } catch { return null; }
}
export async function saveBoardThumbnail(boardId, image) {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('images', 'readwrite'), store = tx.objectStore('images');
      store.put({ boardId, image, updatedAt: Date.now() });
      // Optional preview cache stays bounded even after boards are deleted.
      let count = 0;
      const cursor = store.index('updatedAt').openCursor(null, 'prev');
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        if (++count > 100) cursor.result.delete();
        cursor.result.continue();
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } catch { return false; }
}
