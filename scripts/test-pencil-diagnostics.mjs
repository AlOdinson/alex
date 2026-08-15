import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const board = await readFile(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
const diagnostics = await readFile(new URL('../src/lib/pencilDiagnostics.js', import.meta.url), 'utf8');

assert.match(diagnostics, /get\(DEBUG_QUERY_KEY\) === '1'/,
  'diagnostics must require the explicit pencilDebug=1 query flag');
assert.match(diagnostics, /window\.addEventListener\(type, handler, \{ capture: true, passive: true \}\)/,
  'raw observation must remain passive and capture events before board handlers');
assert.match(diagnostics, /MAX_LOG_LINES = 4800/,
  'the in-memory journal must be bounded');
assert.doesNotMatch(diagnostics, /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/,
  'diagnostics must not transmit data');
assert.doesNotMatch(diagnostics, /\b(?:localStorage|sessionStorage|indexedDB|supabase)\b/i,
  'diagnostics must not persist data outside memory');

for (const marker of [
  'RAW pointerdown',
  'RAW orphan pen contact start',
  'RAW orphan pen contact sample',
  'RAW orphan stylus touchmove start',
  'RAW orphan compatibility mouse contact',
  'APP capture pointerdown',
  'FABRIC pointerdown',
  'FABRIC path:created',
  'BOARD commitAddedObject',
  'DURABLE enqueue',
  'DURABLE confirmed',
  'ARBITRATION native end bridged',
]) {
  assert.ok(board.includes(marker) || diagnostics.includes(marker), `missing diagnostic marker: ${marker}`);
}

assert.match(diagnostics, /\['pointerrawupdate', pointerHandler\]/,
  'diagnostics must observe pointerrawupdate without mutating it');
assert.match(diagnostics, /\['touchmove', touchHandler\]/,
  'diagnostics must observe stylus touchmove events that have no touchstart');
assert.match(diagnostics, /pointerHasContact\(event\)/,
  'orphan Pencil contact detection must use buttons or pressure');

assert.match(board, /pencilDiagnosticsRef\.current = createPencilDiagnostics\(/,
  'Board must initialize the isolated diagnostic observer');
assert.match(board, /pencilDiagnosticsRef\.current\?\.destroy\(\)/,
  'Board must remove the observer and panel during cleanup');

console.log('Apple Pencil diagnostics isolation checks passed.');
