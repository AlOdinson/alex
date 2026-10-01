export const MEDIA_LIMITS = { pdf: 25 * 1024 * 1024, gif: 10 * 1024 * 1024 };
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

export function createMediaAssetStore({ indexedDB = globalThis.indexedDB,
  crypto = globalThis.crypto, onPersistenceError = () => {} } = {}) {
  const fallback = new Map();
  const rooms = new Map();
  let disposed = false;
  const roomKey = (boardId, assetId) => `${String(boardId)}:${assetId}`;
  const open = () => new Promise((resolve, reject) => {
    if (!indexedDB) { reject(new Error('Постоянное сохранение файла недоступно')); return; }
    const req = indexedDB.open('alex-board-media', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets');
      if (!db.objectStoreNames.contains('rooms')) db.createObjectStore('rooms');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Сохранение файла заблокировано другой вкладкой'));
  });
  const operation = async (store, mode, key, value) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = mode === 'readonly' ? tx.objectStore(store).get(key) : tx.objectStore(store).put(value, key);
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error || req.error); };
    });
  };
  const digest = async (blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return { bytes, assetId: [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,'0')).join('') };
  };
  const getAny = async (assetId) => {
    try {
      const durable = await operation('assets','readonly',assetId);
      if (durable) return durable;
    } catch { /* try temporary bytes */ }
    return fallback.get(assetId) || null;
  };
  return {
    async importFile(boardId, file) {
      if (disposed) throw new Error('Media store closed');
      if (!file || !Number.isSafeInteger(file.size) || file.size > MEDIA_LIMITS.pdf) {
        throw new Error('Максимальный размер PDF — 25 МБ, GIF — 10 МБ');
      }
      const { bytes, assetId } = await digest(file);
      const kind = mediaKindFromBytes(bytes);
      if (file.size > MEDIA_LIMITS[kind]) throw new Error(`Максимальный размер ${kind.toUpperCase()} — ${kind==='pdf'?25:10} МБ`);
      const metadata = validateMediaMetadata({ assetId, kind, name: String(file.name || kind).slice(0,200),
        mime: kind==='pdf'?'application/pdf':'image/gif', size:file.size });
      const record = { metadata, persisted: true, blob: new Blob([bytes],{type:metadata.mime}) };
      let persisted = true;
      try {
        await operation('assets','readwrite',assetId,record);
        await operation('rooms','readwrite',roomKey(boardId,assetId),true);
        fallback.delete(assetId);
      } catch (error) { persisted=false; record.persisted=false; fallback.set(assetId,record); onPersistenceError(error); }
      const key=roomKey(boardId,assetId);
      if(persisted || rooms.get(key)!==true)rooms.set(key,persisted);
      return { ...metadata, persisted };
    },
    async get(boardId, assetId) {
      if (disposed) return null;
      let allowed=rooms.has(roomKey(boardId,assetId));
      if (!allowed) {
        try { allowed=Boolean(await operation('rooms','readonly',roomKey(boardId,assetId))); } catch { /* fallback */ }
      }
      if(!allowed)return null;
      const record=await getAny(assetId);
      return record ? {...record,persisted:record.persisted!==false && rooms.get(roomKey(boardId,assetId))!==false} : null;
    },
    async register(boardId, assetId) {
      if (!(await getAny(assetId))) throw new Error('Медиафайл отсутствует на этом устройстве');
      try { await operation('rooms','readwrite',roomKey(boardId,assetId),true); }
      catch (error) { onPersistenceError(error); throw new Error('Не удалось сохранить медиафайл в новой доске', {cause:error}); }
      rooms.set(roomKey(boardId,assetId),true);
    },
    dispose() { disposed=true; fallback.clear(); rooms.clear(); },
  };
}
export const boardMediaAssets = createMediaAssetStore();
