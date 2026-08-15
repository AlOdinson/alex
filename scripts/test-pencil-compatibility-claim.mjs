import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const boardSource = await readFile(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
const pointerDownSource = boardSource.slice(
  boardSource.indexOf('function handlePalmPointerDown'),
  boardSource.indexOf('function handlePalmPointerMove'),
);

const claimStart = pointerDownSource.indexOf('const shouldSuppressPenCompatibilityMouse');
const nextContactCleanup = pointerDownSource.indexOf('// A pointerdown always denotes a new physical contact');
assert.ok(claimStart >= 0, 'Pencil drawing pointerdown must claim the native browser contact');
assert.ok(nextContactCleanup > claimStart, 'The browser contact must be claimed before Fabric contact cleanup');

const claimSource = pointerDownSource.slice(claimStart, nextContactCleanup);
assert.match(claimSource, /drawingToolActive\s*&&\s*canEditRef\.current/);
assert.match(claimSource, /event\.button <= 0\s*&&\s*event\.cancelable/);
assert.match(claimSource, /event\.preventDefault\(\);/);
assert.doesNotMatch(claimSource, /stopPropagation|stopImmediatePropagation/,
  'Claiming the browser gesture must not keep the real PointerEvent away from Fabric');

// Model the exact scope: only editable Pencil/partial-eraser drawing contacts are
// cancelled. Selection, finger zoom and read-only viewers keep their prior behavior.
const shouldClaim = ({ tool, eraserMode = 'object', canEdit = true, button = 0, cancelable = true }) => {
  const drawingToolActive = tool === 'pencil' || (tool === 'eraser' && eraserMode === 'partial');
  return drawingToolActive && canEdit && button <= 0 && cancelable;
};

assert.equal(shouldClaim({ tool: 'pencil' }), true);
assert.equal(shouldClaim({ tool: 'eraser', eraserMode: 'partial' }), true);
assert.equal(shouldClaim({ tool: 'select' }), false);
assert.equal(shouldClaim({ tool: 'eraser', eraserMode: 'object' }), false);
assert.equal(shouldClaim({ tool: 'pencil', canEdit: false }), false);
assert.equal(shouldClaim({ tool: 'pencil', button: 1 }), false);
assert.equal(shouldClaim({ tool: 'pencil', cancelable: false }), false);

assert.match(boardSource, /enablePointerEvents: true/,
  'The fast PointerEvent path used by Pencil transforms must remain enabled');

console.log('Apple Pencil compatibility-mouse claim regression tests passed.');
