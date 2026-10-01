import { withLocalFileLifecycle } from './localFileLifecycle.js';
import { studentOfflineStorage } from './studentOfflineCache.js';
import { boardMediaAssets } from './mediaAssetStore.js';
import { getAuthorityBoard, listAuthorityBoards } from './browserAuthorityStore.js';
import { clearBoardCache, listCachedSnapshotBoardIds } from './idb.js';

export function createStudentLessonLibrary({ storage = studentOfflineStorage,
  media = boardMediaAssets, getOwned = getAuthorityBoard, listOwned = listAuthorityBoards,
  listCached = listCachedSnapshotBoardIds, clearCache = clearBoardCache } = {}) {
  const recover = async () => {
    const pending = await storage.pendingMediaCleanup();
    if (!pending.length) return;
    const lessons = await storage.list();
    for (const { boardId, legacy } of pending) {
      if (legacy) {
        // Old archives did not save their boardId. Only reconcile their unknown
        // memberships after the final old archive is removed or upgraded.
        if (lessons.some(entry => !entry.boardId)) continue;
        const retained = new Set([...lessons.map(entry => entry.boardId), ...(await listOwned()).map(board => board.boardId)]);
        for (const id of await listCached()) if (!retained.has(id)) await clearCache(id);
        for (const id of await media.listBoardIds()) if (!retained.has(id)) await media.releaseBoard(id);
        await storage.finishMediaCleanup(null);
        continue;
      }
      if (!lessons.some(entry => entry.boardId === boardId) && !(await getOwned(boardId))) {
        await clearCache(boardId);
        await media.releaseBoard(boardId);
      }
      await storage.finishMediaCleanup(boardId);
    }
  };
  return {
    async list() {
      await withLocalFileLifecycle(recover);
      const groups = new Map();
      for (const entry of await storage.list()) {
        const key = entry.boardId || entry.scope;
        const current = groups.get(key) || { key, boardId: entry.boardId, scopes: [], title: '', savedAt: 0 };
        current.scopes.push(entry.scope);
        current.title = entry.title || current.title;
        current.savedAt = Math.max(current.savedAt, Number(entry.savedAt) || 0);
        groups.set(key, current);
      }
      return [...groups.values()].sort((a,b) => b.savedAt - a.savedAt);
    },
    async remove(lesson) {
      return withLocalFileLifecycle(async () => {
      // Read current scopes, so an older UI card cannot omit another saved copy.
      const entries = await storage.list();
      for (const entry of entries) {
        if (lesson.boardId ? entry.boardId === lesson.boardId : lesson.scopes.includes(entry.scope)) {
          await storage.remove(entry.scope);
        }
      }
      await recover();
      });
    },
  };
}
export const studentLessonLibrary = createStudentLessonLibrary();
