export const MEDIA_LIMITS = { pdf: 100 * 1024 * 1024, gif: 25 * 1024 * 1024 };
export const MEDIA_VERSION = 1;
export function mediaKindFromBytes(bytes) {
  const header = String.fromCharCode(...bytes.slice(0, 8));
  if (header.startsWith('%PDF-')) return 'pdf';
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'gif';
  throw new Error('Неподдерживаемый формат PDF/GIF');
}
export function validateMediaMetadata(metadata) {
  if (!metadata || !/^[a-f0-9]{64}$/.test(metadata.assetId)
    || !MEDIA_LIMITS[metadata.kind] || !Number.isSafeInteger(metadata.size)
    || metadata.size < 6 || metadata.size > MEDIA_LIMITS[metadata.kind]) {
    throw new Error('Некорректный формат или размер медиафайла');
  }
  return metadata;
}
const requestResult = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const deletedError = () => Object.assign(new Error('Доска удалена'), { name: 'DeletedBoardError' });

export function createMediaAssetStore({ indexedDB = globalThis.indexedDB,
  crypto = globalThis.crypto, onPersistenceError = () => {} } = {}) {
  const fallback = new Map(), rooms = new Map();
  let disposed = false;
  const roomKey = (boardId, assetId) => `${String(boardId)}:${assetId}`;
  const open = () => new Promise((resolve, reject) => {
    if (!indexedDB) { reject(new Error('Постоянное сохранение файла недоступно')); return; }
    const req = indexedDB.open('alex-board-media', 2);
    let settled = false;
    const fail = error => { if(settled)return;settled=true;clearTimeout(timer);reject(error); };
    const timer = setTimeout(() => fail(new Error('Хранилище медиафайлов не отвечает')), 15_000);
    req.onupgradeneeded = () => {
      if(settled){req.transaction.abort();return;}
      const db = req.result;
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets');
      const links = db.objectStoreNames.contains('rooms')
        ? req.transaction.objectStore('rooms') : db.createObjectStore('rooms');
      if (!links.indexNames.contains('boardId')) links.createIndex('boardId', 'boardId');
      if (!links.indexNames.contains('assetId')) links.createIndex('assetId', 'assetId');
      if (!db.objectStoreNames.contains('deletedBoards')) db.createObjectStore('deletedBoards');
      // Preserve all v1 memberships, including student/offline rooms.
      const cursor = links.openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        if (entry.value === true) {
          const key = String(entry.key), split = key.lastIndexOf(':');
          entry.update({ boardId: key.slice(0, split), assetId: key.slice(split + 1) });
        }
        entry.continue();
      };
    };
    req.onsuccess = () => {
      if(settled){req.result.close();return;}
      settled=true;clearTimeout(timer);req.result.onversionchange = () => req.result.close(); resolve(req.result);
    };
    req.onerror = () => fail(req.error);
    req.onblocked = () => fail(new Error('Сохранение файла заблокировано другой вкладкой'));
  });
  const transaction = async (mode, work) => {
    const db = await open();
    let tx, timer;
    try {
      tx = db.transaction(['assets', 'rooms', 'deletedBoards'], mode);
      const completion = new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(tx.error || new Error('Не удалось сохранить медиафайл'));
        timer=setTimeout(()=>{reject(new Error('Хранилище медиафайлов не отвечает'));try{tx.abort();}catch{}},30_000);
      });
      completion.catch(() => {});
      const [result] = await Promise.all([
        work(tx.objectStore('assets'), tx.objectStore('rooms'), tx.objectStore('deletedBoards')), completion,
      ]);
      return result;
    } catch (error) { try { tx?.abort(); } catch { /* ended */ } throw error; }
    finally { clearTimeout(timer); db.close(); }
  };
  const checkBoard = async (deleted, boardId) => {
    if (await requestResult(deleted.get(String(boardId)))) throw deletedError();
  };
  return {
    async importFile(boardId, file, { expectedAssetId, expectedKind } = {}) {
      if (disposed) throw new Error('Media store closed');
      if (!file || !Number.isSafeInteger(file.size) || file.size > MEDIA_LIMITS.pdf) {
        throw new Error('Максимальный размер PDF — 100 МБ, GIF — 25 МБ');
      }
      const kind = mediaKindFromBytes(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
      if (expectedKind && kind !== expectedKind) throw new Error('Формат файла не совпадает');
      if (file.size > MEDIA_LIMITS[kind]) throw new Error(`Максимальный размер ${kind.toUpperCase()} — ${kind === 'pdf' ? 100 : 25} МБ`);
      const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const assetId = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (expectedAssetId && assetId !== expectedAssetId) throw new Error('Проверка целостности файла не пройдена');
      const metadata = validateMediaMetadata({ assetId, kind, name: String(file.name || kind).slice(0, 200),
        mime: kind === 'pdf' ? 'application/pdf' : 'image/gif', size: file.size });
      // Keep the Blob itself; do not allocate a second full byte array for storage.
      const record = { metadata, persisted: true, blob: file.slice(0, file.size, metadata.mime) };
      let persisted = true;
      try {
        await transaction('readwrite', async (assets, links, deleted) => {
          await checkBoard(deleted, boardId);
          if (!(await requestResult(assets.getKey(assetId)))) await requestResult(assets.put(record, assetId));
          await requestResult(links.put({ boardId: String(boardId), assetId }, roomKey(boardId, assetId)));
        });
        fallback.delete(assetId); rooms.delete(roomKey(boardId, assetId));
      } catch (error) {
        if (error.name === 'DeletedBoardError') throw error;
        persisted = false; fallback.set(assetId, { ...record, persisted: false });
        rooms.set(roomKey(boardId, assetId), true); onPersistenceError(error);
      }
      return { ...metadata, persisted };
    },
    async get(boardId, assetId) {
      if (disposed) return null;
      try {
        return await transaction('readonly', async (assets, links, deleted) => {
          if (await requestResult(deleted.get(String(boardId)))) return null;
          if (await requestResult(links.get(roomKey(boardId, assetId)))) {
            return await requestResult(assets.get(assetId)) || null;
          }
          return rooms.has(roomKey(boardId, assetId)) ? fallback.get(assetId) || null : null;
        });
      } catch {
        return rooms.has(roomKey(boardId, assetId)) ? fallback.get(assetId) || null : null;
      }
    },
    async register(boardId, assetId) {
      if (disposed) throw new Error('Media store closed');
      try {
        await transaction('readwrite', async (assets, links, deleted) => {
          await checkBoard(deleted, boardId);
          if (!(await requestResult(assets.getKey(assetId)))) throw new Error('Медиафайл отсутствует на этом устройстве');
          await requestResult(links.put({ boardId: String(boardId), assetId }, roomKey(boardId, assetId)));
        });
        rooms.delete(roomKey(boardId, assetId));
      } catch (error) {
        if (error.name === 'DeletedBoardError') throw error;
        onPersistenceError(error); throw new Error('Не удалось сохранить медиафайл в новой доске', { cause: error });
      }
    },
    async deleteBoard(boardId) {
      const key = String(boardId);
      await transaction('readwrite', async (assets, links, deleted) => {
        await requestResult(deleted.put(true, key));
        const memberships = await requestResult(links.index('boardId').getAll(key));
        for (const { assetId } of memberships) {
          await requestResult(links.delete(roomKey(key, assetId)));
          if (!(await requestResult(links.index('assetId').count(assetId)))) await requestResult(assets.delete(assetId));
        }
      });
      for (const link of [...rooms.keys()]) if (link.startsWith(`${key}:`)) rooms.delete(link);
      for (const assetId of [...fallback.keys()]) {
        if (![...rooms.keys()].some(link => link.endsWith(`:${assetId}`))) fallback.delete(assetId);
      }
    },
    dispose() { disposed = true; fallback.clear(); rooms.clear(); },
  };
}
export const boardMediaAssets = createMediaAssetStore();
