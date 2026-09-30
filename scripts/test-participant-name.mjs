import assert from 'node:assert/strict';
import test from 'node:test';

const KEY = 'alex-board:participant-name';
function storage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}
let serial = 0;
async function setup(local = storage(), session = storage()) {
  globalThis.window = { localStorage: local, sessionStorage: session };
  return import(`../src/lib/participantName.js?test=${serial++}`);
}
test('saved name applies to every board and survives a fresh module', async () => {
  const local = storage();
  const names = await setup(local);
  names.saveParticipantName('  Alex  ');
  assert.equal(names.getParticipantName('first'), 'Alex');
  assert.equal(names.getParticipantName('second'), 'Alex');
  const reloaded = await setup(local);
  assert.equal(reloaded.getParticipantName(), 'Alex');
});
test('migrates owner name before stale per-board names', async () => {
  const local = storage({ 'alex-board:owner-name': 'Teacher' });
  const names = await setup(local, storage({ 'alex-board:name:first': 'Old guest' }));
  assert.equal(names.getParticipantName('first'), 'Teacher');
  assert.equal(local.getItem(KEY), 'Teacher');
});
test('migrates a guest name for use on other boards', async () => {
  const names = await setup(storage(), storage({ 'alex-board:name:first': 'Student' }));
  assert.equal(names.getParticipantName('first'), 'Student');
  assert.equal(names.getParticipantName('second'), 'Student');
});
test('explicit clearing survives reload and never revives legacy names', async () => {
  const local = storage({ 'alex-board:owner-name': 'Old owner' });
  const session = storage({ 'alex-board:name:first': 'Old guest' });
  const names = await setup(local, session);
  names.saveParticipantName('');
  const reloaded = await setup(local, session);
  assert.equal(reloaded.getParticipantName('first'), '');
});
test('a saved browser name overrides stale per-board names and is bounded to 40 characters', async () => {
  const names = await setup(storage({ [KEY]: 'Current' }), storage({ 'alex-board:name:first': 'Old' }));
  assert.equal(names.getParticipantName('first'), 'Current');
  names.saveParticipantName('a'.repeat(60));
  assert.equal(names.getParticipantName().length, 40);
});
test('blocked storage does not prevent entering or clearing a name in this session', async () => {
  const names = await setup();
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('blocked'); } });
  Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('blocked'); } });
  assert.equal(names.getParticipantName('first'), '');
  names.saveParticipantName('Sam');
  assert.equal(names.getParticipantName('second'), 'Sam');
  names.saveParticipantName('');
  assert.equal(names.getParticipantName(), '');
});
