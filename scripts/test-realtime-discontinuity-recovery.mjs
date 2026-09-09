import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../src/lib/realtime.js'), 'utf8');

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

expect(
  source.includes('getBoardObjectLocks'),
  'continuity recovery must refresh authoritative object locks',
);
expect(
  /ablyChannel\.on\(['"]attached['"][\s\S]*?resumed\s*===\s*false/.test(source),
  'must recover when an Ably channel reattaches without continuity',
);
expect(
  /ablyChannel\.on\(['"]update['"][\s\S]*?resumed\s*===\s*false/.test(source),
  'must recover on Ably UPDATE discontinuity',
);

const recoveryStart = source.indexOf('const recoverAblySession');
const recoveryEnd = source.indexOf('const startAblyTransport', recoveryStart);
expect(
  recoveryStart >= 0 && recoveryEnd > recoveryStart,
  'must define a bounded Ably recovery routine',
);
const recovery = source.slice(recoveryStart, recoveryEnd);
for (const token of [
  'flushPending()',
  'refreshAblyUsers',
  'refreshAuthoritativeLocks',
  'onSyncRequired?.',
]) {
  expect(recovery.includes(token), `Ably recovery is missing ${token}`);
}
expect(
  source.includes("recoverAblySession('connection-reconnected')"),
  'a later Ably connection reconnect must trigger recovery',
);

console.log('Realtime discontinuity recovery regression passed.');
