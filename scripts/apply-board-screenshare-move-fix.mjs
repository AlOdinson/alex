import fs from 'node:fs';

const path = new URL('../src/components/Board.jsx', import.meta.url);
let source = fs.readFileSync(path, 'utf8');

const before = `  const acquireLocalSelectionLease = useCallback((target) => {\n    if (!target || !canEditRef.current || applyingRemoteRef.current || applyingHistoryRef.current) {\n      return Promise.resolve(false);\n    }\n    const ids = selectionObjectIds(target);`;
const after = `  const acquireLocalSelectionLease = useCallback((target) => {\n    if (!target || !canEditRef.current || applyingRemoteRef.current || applyingHistoryRef.current) {\n      return Promise.resolve(false);\n    }\n    // ShareScreen is a realtime-only media object, not a durable board object.\n    // It has no boardObjectId and therefore must never be frozen waiting for a\n    // Supabase object lease. Its transforms are synchronized through screen-layout.\n    if (isBoardScreenShareObject(target)) {\n      setSelectionLeaseInteraction(target, true);\n      return Promise.resolve(true);\n    }\n    const ids = selectionObjectIds(target);`;

if (!source.includes(after)) {
  if (!source.includes(before)) throw new Error('ShareScreen lease patch target not found');
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
}
