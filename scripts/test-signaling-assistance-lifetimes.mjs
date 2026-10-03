import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual browser instrumentation without opening a socket. The
// invariant is concurrent live peers, not the number of discarded attempts.
const source = fs.readFileSync(new URL('./test-signaling-assistance-e2e.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function instrument(');
const end = source.indexOf('\nasync function enter(', start);
assert.ok(start >= 0 && end > start);
const guardStart = source.indexOf('      for (const evidence of after) {');
const guardEnd = source.indexOf('\n\n      const allSignals', guardStart);
assert.ok(guardStart >= 0 && guardEnd > guardStart);
const verify = new Function('after', 'assert', source.slice(guardStart, guardEnd));

async function fixture() {
  class Peer extends EventTarget {
    connectionState = 'new'; iceConnectionState = 'new'; signalingState = 'stable';
    failClose = false;
    createDataChannel(label) { const channel = new EventTarget(); channel.label = label; channel.readyState = 'connecting'; return channel; }
    close() {
      if (this.failClose) throw new Error('native close failure');
      this.connectionState = this.iceConnectionState = this.signalingState = 'closed';
    }
  }
  const window = { RTCPeerConnection: Peer };
  const instrument = vm.runInNewContext(`${source.slice(start, end)}\ninstrument`, {
    window, performance: { now: () => 1 }, process: { env: {} }, document: {},
  });
  await instrument({ addInitScript: async (fn, args) => fn(args) }, 'clean', true);
  return { Peer: window.RTCPeerConnection, evidence: window.__signalEvidence };
}

test('closed retries are sequential even when cumulative attempts exceed two', async () => {
  const { Peer, evidence } = await fixture();
  for (let i = 0; i < 3; i++) new Peer().close();
  new Peer();
  assert.equal(evidence.pcCount, 4);
  assert.doesNotThrow(() => verify([evidence], assert));
  assert.equal(evidence.maxActivePcCount, 1);
  assert.equal(evidence.activePcCount, 1);
  assert.equal(evidence.peerEvents.filter(e => e.event === 'pc-close').length, 3);
});

test('two overlapping peers fail even though the old cumulative limit allowed them', async () => {
  const { Peer, evidence } = await fixture();
  new Peer(); new Peer();
  assert.equal(evidence.pcCount, 2);
  assert.throws(() => verify([evidence], assert), /one path at a time/);
});

test('closing an overlap later cannot erase a previously observed violation', async () => {
  const { Peer, evidence } = await fixture();
  const first = new Peer(); new Peer(); first.close();
  assert.equal(evidence.activePcCount, 1);
  assert.equal(evidence.maxActivePcCount, 2);
  assert.throws(() => verify([evidence], assert), /one path at a time/);
});

test('close is idempotent and a finished session cannot masquerade as ready', async () => {
  const { Peer, evidence } = await fixture();
  const peer = new Peer(); peer.close(); peer.close();
  assert.equal(evidence.activePcCount, 0);
  assert.equal(evidence.maxActivePcCount, 1);
  assert.throws(() => verify([evidence], assert), /one live peer/);
});

test('a failed native close is not counted as successful teardown', async () => {
  const { Peer, evidence } = await fixture();
  const first = new Peer(); first.failClose = true;
  assert.throws(() => first.close(), /native close failure/);
  new Peer();
  assert.equal(evidence.activePcCount, 2);
  assert.throws(() => verify([evidence], assert), /one path at a time/);
});

test('a fixture with no peer is rejected', async () => {
  const { evidence } = await fixture();
  assert.throws(() => verify([evidence], assert));
});
