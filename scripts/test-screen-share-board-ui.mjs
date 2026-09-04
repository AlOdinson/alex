import assert from 'node:assert/strict';
import fs from 'node:fs';

const toolbar = fs.readFileSync(new URL('../src/components/Toolbar.jsx', import.meta.url), 'utf8');
const screenShare = fs.readFileSync(new URL('../src/components/ScreenShare.jsx', import.meta.url), 'utf8');

assert.match(
  toolbar,
  /\{canEdit\s*&&\s*screenShare\s*&&\s*\(\s*<span className="desktop-screen-share">/,
  'ShareScreen control must be visible to every editor, not only the owner.',
);
assert.doesNotMatch(
  toolbar,
  /\{isOwner\s*&&\s*screenShare\s*&&\s*\(\s*<span className="desktop-screen-share">/,
  'ShareScreen control must not remain owner-only.',
);
assert.match(
  screenShare,
  /const boardScreenLivesOnCanvas = !remoteBrowser[\s\S]*?\['hosting', 'viewing', 'connecting'\]\.includes\(phase\);/,
  'Normal active screen sharing must be recognized as living on the Fabric canvas.',
);
assert.match(
  screenShare,
  /if \(boardScreenLivesOnCanvas\) return null;/,
  'The old fixed overlay must not duplicate an active normal screen-share video.',
);
assert.match(
  screenShare,
  /\|\| \(!remoteBrowser && phase === 'paused'\)/,
  'A paused normal screen share may keep only a status notice, not the old video panel.',
);

console.log('screen-share board UI regression passed');
