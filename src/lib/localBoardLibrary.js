import { deriveShareKey as defaultDeriveShareKey, randomToken as defaultRandomToken } from './ids.js';
import {
  createAuthorityBoard,
  deleteAuthorityBoard,
  getAuthorityBoard,
  listAuthorityBoards,
  updateAuthorityBoardMetadata,
} from './browserAuthorityStore.js';

function cleanTitle(value) {
  return String(value ?? '').trim() || 'Новая доска';
}

export function createLocalBoardLibrary({
  createBoardRecord = createAuthorityBoard,
  listBoardRecords = listAuthorityBoards,
  getBoardRecord = getAuthorityBoard,
  updateBoardRecord = updateAuthorityBoardMetadata,
  deleteBoardRecord = deleteAuthorityBoard,
  randomToken = defaultRandomToken,
  deriveShareKey = defaultDeriveShareKey,
} = {}) {
  return {
    async createBoard(title = 'Новая доска', studentName = '') {
      const boardId = randomToken(12);
      const ownerKey = randomToken(28);
      const shareKey = await deriveShareKey(ownerKey);
      // The share secret is also the unguessable realtime room secret. This removes
      // the need for any server-side boardId -> realtimeKey mapping.
      const realtimeKey = shareKey;
      const record = await createBoardRecord({
        boardId,
        ownerKey,
        shareKey,
        realtimeKey,
        title: cleanTitle(title),
        studentName: String(studentName ?? '').trim(),
        guestMode: 'edit',
      });
      return record;
    },

    listBoards() {
      return listBoardRecords();
    },

    getBoard(boardId) {
      return getBoardRecord(String(boardId ?? '').trim());
    },

    renameBoard(boardId, title) {
      return updateBoardRecord(String(boardId ?? '').trim(), { title: cleanTitle(title) });
    },

    setStudentName(boardId, studentName) {
      return updateBoardRecord(String(boardId ?? '').trim(), {
        studentName: String(studentName ?? '').trim(),
      });
    },

    setGuestMode(boardId, guestMode) {
      return updateBoardRecord(String(boardId ?? '').trim(), {
        guestMode: guestMode === 'view' ? 'view' : 'edit',
      });
    },

    setGameLibraryVisible(boardId, visible) {
      return updateBoardRecord(String(boardId ?? '').trim(), {
        gameLibraryVisible: Boolean(visible),
      });
    },

    deleteBoard(boardId) {
      return deleteBoardRecord(String(boardId ?? '').trim());
    },
  };
}

export const localBoardLibrary = createLocalBoardLibrary();
