import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Execute the actual early revision guard from the Canvas installation path.
// An archive is display-only; it must not veto the first real owner baseline.
const board = readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');
const install = board.slice(board.indexOf('const applyAuthoritativeSnapshot = useCallback('));
const guard = install.match(/if \([^\n]*Number\(revision \?\? 0\)[^\n]*\) return;/)?.[0];
assert.ok(guard, 'locate the actual snapshot revision guard');
const accepts = new Function('revision', 'revisionRef', 'viewingArchiveRef', `${guard}\nreturn true;`);

test('a viewing-only archive cannot veto a lower but real owner snapshot', () => {
  assert.equal(accepts(5, { current: 1005 }, { current: true }), true);
});
test('ordinary live snapshots retain their stale-revision fence', () => {
  assert.equal(accepts(5, { current: 1005 }, { current: false }), undefined);
  assert.equal(accepts(1005, { current: 1005 }, { current: false }), true);
});
