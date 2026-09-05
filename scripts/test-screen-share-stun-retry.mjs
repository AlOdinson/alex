import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rtcConfiguration } from '../src/lib/screenShare.js';

const screenShareSource = fs.readFileSync(
  new URL('../src/components/ScreenShare.jsx', import.meta.url),
  'utf8',
);

const config = rtcConfiguration();
const urls = (Array.isArray(config?.iceServers) ? config.iceServers : [])
  .flatMap((server) => (Array.isArray(server?.urls) ? server.urls : [server?.urls]))
  .filter(Boolean)
  .map(String);

assert.ok(urls.length >= 3, `STUN-only mode should try at least three STUN endpoints, got ${urls.length}.`);
assert.ok(
  urls.every((url) => url.startsWith('stun:')),
  `STUN-only mode must not contain TURN/TURNS endpoints: ${urls.join(', ')}`,
);
assert.ok(
  Number(config?.iceCandidatePoolSize ?? 0) >= 2,
  'STUN-only mode should pre-gather multiple ICE candidates.',
);

assert.match(
  screenShareSource,
  /viewerStunRetryAttemptsRef\s*=\s*useRef\(0\)/,
  'Viewer must track bounded STUN retry attempts.',
);
assert.match(
  screenShareSource,
  /restartIce:\s*true/,
  'A failed direct screen-share connection must request a fresh ICE/STUN negotiation.',
);
assert.match(
  screenShareSource,
  /createHostPeer\(signal\.clientId,\s*\{\s*force:\s*Boolean\(signal\.restartIce\)\s*\}\)/,
  'Host must force-create a fresh peer for a STUN retry request.',
);
assert.match(
  screenShareSource,
  /session\.sourceMode\s*!==\s*'remote-browser'[\s\S]*?Повторно устанавливаю прямое соединение/,
  'Ordinary ShareScreen failures should retry direct STUN instead of referring to the Mac relay.',
);
assert.match(
  screenShareSource,
  /Прямое соединение не установилось\. Попробуйте обновить страницу или сменить сеть\./,
  'After bounded STUN retries, the ordinary screen-share error should describe the direct connection failure.',
);

console.log('screen-share STUN-only retry regression passed');
