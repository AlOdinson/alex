import { isNotebookOperation } from './notebookOperations.js';

export const NOTEBOOK_VERSION = 1;
export const supportsNotebookOperations = peer => peer?.notebookVersion === NOTEBOOK_VERSION;
export const hasNotebookOperations = ops => Array.isArray(ops) && ops.some(op => op?.type === 'notebook');
export function notebookUpdateRequired() {
  const error = new Error('Для этого блокнота участнику нужно обновить страницу. / Notebook update required.');
  error.code = 'notebook_update_required';
  return error;
}
export function assertNotebookCommitReadable(commit, supportedVersion = NOTEBOOK_VERSION) {
  if (Number(commit?.notebookVersion ?? 0) > supportedVersion) throw notebookUpdateRequired();
  if (!hasNotebookOperations(commit?.ops)) return;
  if (supportedVersion !== NOTEBOOK_VERSION) throw notebookUpdateRequired();
  if (commit.ops.some(op => op?.type === 'notebook' && !isNotebookOperation(op))) throw notebookUpdateRequired();
}
// A real legacy client cannot apply new deltas. Give an explicit view-only notice,
// not an apparently up-to-date board with silently missing strokes. This is NOT a
// flattened-content compatibility implementation and is intentionally labelled.
export function notebookUpdateSnapshot() {
  return { version: 2, background: 'blank', canvas: { objects: [{
    type: 'Textbox', version: '7.4.0', boardObjectId: 'notebook-update-required',
    left: 120, top: 120, originX: 'left', originY: 'top', width: 640,
    fontFamily: 'Arial', fontSize: 26, fill: '#111827', editable: false,
    text: 'Обновите страницу, чтобы открыть этот блокнот. Записи сохранены. / Refresh this board to open the notebook. Your work is saved.',
  }] } };
}

// Trusted build-time rollout switch. Peer payloads never activate local writers.
export function isNotebookRuntimeEnabled(env = import.meta.env) {
  return env?.VITE_NOTEBOOK_OPERATIONS_V1 === 'true';
}
