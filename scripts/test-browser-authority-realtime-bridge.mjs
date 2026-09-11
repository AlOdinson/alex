import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/lib/realtime.js', import.meta.url), 'utf8');

assert.match(source, /onPeerSignal,/);
assert.match(source, /event === 'peer-signal'[\s\S]*onPeerSignal\?\./);
assert.match(source, /sendPeerSignal\(signal\)[\s\S]*publishRealtime\('peer-signal'/);
assert.match(source, /publishRealtime\('peer-signal'[\s\S]*\{ force: true \}/);

console.log('browser authority realtime signaling bridge: ok');
