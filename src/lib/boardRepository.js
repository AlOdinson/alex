import {
  applyActionsToSnapshot,
  applyOpsToSnapshot,
  browserBoardRepository,
  isSupabaseConfigured,
} from './browserBoardRepositoryCompat.js';

export { applyActionsToSnapshot, applyOpsToSnapshot, isSupabaseConfigured };

export const createBoard = (...args) => browserBoardRepository.createBoard(...args);
export const getOwnedBoardSummaries = (...args) => browserBoardRepository.getOwnedBoardSummaries(...args);
export const deleteOwnedBoards = (...args) => browserBoardRepository.deleteOwnedBoards(...args);
export const getBoardAccess = (...args) => browserBoardRepository.getBoardAccess(...args);
export const getBoardRevision = (...args) => browserBoardRepository.getBoardRevision(...args);
export const getBoardChanges = (...args) => browserBoardRepository.getBoardChanges(...args);
export const getBoardRecovery = (...args) => browserBoardRepository.getBoardRecovery(...args);
export const setGuestMode = (...args) => browserBoardRepository.setGuestMode(...args);
export const setGameLibraryVisibility = (...args) => browserBoardRepository.setGameLibraryVisibility(...args);
export const setBoardMetadata = (...args) => browserBoardRepository.setBoardMetadata(...args);
export const deleteBoard = (...args) => browserBoardRepository.deleteBoard(...args);
export const duplicateBoard = (...args) => browserBoardRepository.duplicateBoard(...args);
export const acquireBoardObjectLocks = (...args) => browserBoardRepository.acquireBoardObjectLocks(...args);
export const refreshBoardObjectLocks = (...args) => browserBoardRepository.refreshBoardObjectLocks(...args);
export const releaseBoardObjectLocks = (...args) => browserBoardRepository.releaseBoardObjectLocks(...args);
export const getBoardObjectLocks = (...args) => browserBoardRepository.getBoardObjectLocks(...args);
export const applyBoardAction = (...args) => browserBoardRepository.applyBoardAction(...args);
export const applyBoardActionBatch = (...args) => browserBoardRepository.applyBoardActionBatch(...args);
export const saveBoardSnapshot = (...args) => browserBoardRepository.saveBoardSnapshot(...args);
