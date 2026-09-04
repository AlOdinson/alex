import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');

function has(pattern, message) {
  assert.match(source, pattern, message);
}

has(/createBoardScreenShareMedia/, 'Board must create the transient Fabric media object.');
has(/isBoardScreenShareObject/, 'Board transform paths must identify transient screen-share objects.');
has(/screenShareLayoutFromFabricObject/, 'Board must translate Fabric transforms back to shared scene geometry.');
has(/screenShareBoardLayoutForViewport/, 'Board must derive the initial screen placement from the current viewport.');
has(/getInitialBoardLayout:\s*getInitialScreenShareBoardLayout/, 'Board must provide the hook a current centered layout.');
has(/boardScreenShareRef\s*=\s*useRef/, 'Board must own a transient screen-share media controller ref.');
has(/screenShare\.sessionId[\s\S]*?createBoardScreenShareMedia/, 'Screen-share session lifecycle must create the board media object.');
has(/screenShare\.stream[\s\S]*?setStream/, 'The existing WebRTC MediaStream must feed the Fabric object.');
has(/screenShare\.boardLayout[\s\S]*?setLayout/, 'Incoming collaborative layout must move/resize the Fabric object.');
has(/screenShareRef\.current\?\.updateBoardLayout\?\.\(/, 'Fabric transforms must broadcast layout through the current screen-share hook.');
has(/before:transform[\s\S]*?isBoardScreenShareObject\(transform\.target\)/, 'before:transform must short-circuit durable object leases for the live screen.');
has(/broadcastLiveTransform[\s\S]*?isBoardScreenShareObject\(target\)/, 'live transforms must use the transient screen-layout channel.');
has(/object:modified[\s\S]*?isBoardScreenShareObject\(target\)/, 'completed transforms must skip durable board history.');
has(/transientScreenShare/, 'Board must explicitly recognize transient screen-share objects.');
has(/selectionUiObjects[\s\S]*?!object\.transientScreenShare/, 'Selection UI must exclude the live screen from durable image operations.');
has(/finalizeSelectionMarquee[\s\S]*?transientScreenShare/, 'Marquee selection must not group the live screen with durable board objects.');
has(/deleteSelection[\s\S]*?!object\.transientScreenShare/, 'Delete must not silently terminate another participant’s live share.');
has(/clearBoard[\s\S]*?!object\.transientScreenShare/, 'Clear board must leave the live share session intact.');

console.log('board screen-share integration regression passed');
