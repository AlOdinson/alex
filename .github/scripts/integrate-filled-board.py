from pathlib import Path
import subprocess

MAIN = '9f97538f9b7bb45b783d8e2c592cb7694233735a'
OURS = '8b63e8d41e606da7e086984df2f85d817dc45885'

def read(ref, name):
    return subprocess.check_output(['git', 'show', f'{ref}:{name}']).decode('utf-8')

def write(name, text):
    Path(name).parent.mkdir(parents=True, exist_ok=True)
    Path(name).write_text(text, encoding='utf-8')

# Start with the entire current main, preserving its owner-room identity fix,
# initial snapshot ordering, signaling-receipt recovery, and all new regressions.
subprocess.run(['git', 'restore', '--source=' + MAIN, '--worktree', '--staged', '.'], check=True)
for name in ['package.json', 'src/durableEditGate.js', 'src/lib/browserBoardSession.js', 'src/lib/peerProtocol.js', 'src/lib/teacherPeerNetwork.js']:
    write(name, read(OURS, name))

s = read(OURS, 'src/lib/peerDataChannel.js').replace('onActivity = () => {},', 'onProgress = () => {},')
s = s.replace('  const handleIncoming = (event) => {', '  const reportProgress = () => {\n    try { onProgress(); } catch { /* watchdog/observer errors must not drop data */ }\n  };\n\n  const handleIncoming = (event) => {')
s = s.replace('      try { onActivity(); } catch { /* progress observers must not affect delivery */ }\n', '')
s = s.replace('        const completed = assembler.accept(message);\n', '        const completed = assembler.accept(message);\n        reportProgress();\n')
s = s.replace('      onMessage(message);\n', '      reportProgress();\n      onMessage(message);\n')
write('src/lib/peerDataChannel.js', s)

s = read(MAIN, 'src/lib/studentPeerNetwork.js')
s = s.replace('  const recordInitialSyncProgress = () => {', "  const failConnection = (error) => {\n    if (closed) return;\n    try { onError(error); } catch { /* observer errors are ignored */ }\n    closeResources(error, { reportState: 'failed' });\n  };\n\n  const recordInitialSyncProgress = () => {")
s = s.replace('onMessage: (message) => Promise.resolve(nextSession?.handleMessage?.(message)).catch(onError)', 'onMessage: (message) => Promise.resolve().then(() => nextSession?.handleMessage?.(message)).catch(failConnection)')
s = s.replace('onTransfer: (transfer) => Promise.resolve(nextSession?.handleTransfer?.(transfer)).catch(onError)', 'onTransfer: (transfer) => Promise.resolve().then(() => nextSession?.handleTransfer?.(transfer)).catch(failConnection)')
s = s.replace('      onError,\n    });\n    nextSession', '      onError: failConnection,\n    });\n    nextSession')
s = s.replace("    channelStart.then(settleReady, (error) => {\n      try { onError(error); } catch { /* observer errors are ignored */ }\n      closeResources(error, { reportState: 'failed' });\n    });", '    channelStart.then(settleReady, failConnection);')
write('src/lib/studentPeerNetwork.js', s)

s = read(OURS, 'scripts/test-filled-board-join.mjs').replace('syncTimeoutMs:', 'initialSyncTimeoutMs:').replace('transportOptions.onActivity?.()', 'transportOptions.onProgress?.()')
s += '''
for (const source of ['frame', 'handler']) {
  test(`student retires a broken ${source} immediately instead of waiting for the watchdog`, async (t) => {
    let connectionOptions;
    let transportOptions;
    let failure;
    let closes = 0;
    const error = new Error(`Broken ${source}`);
    const network = createStudentPeerNetwork({
      teacherId: 'teacher', signaling: { send: async () => {} },
      getRevision: () => 0, applyCommit: async () => {}, installSnapshot: async () => {},
      createConnection: (options) => {
        connectionOptions = options;
        return { async start() {}, close() { closes += 1; } };
      },
      createTransport: (options) => {
        transportOptions = options;
        return { send: async () => {}, close() {} };
      },
      createSession: () => ({
        start: () => new Promise(() => {}),
        handleTransfer() { throw error; },
        close() {},
      }),
    });
    t.after(() => network.close());
    network.start().catch((value) => { failure = value; });
    connectionOptions.onChannel(new Channel());
    if (source === 'frame') transportOptions.onError(error);
    else {
      try { await transportOptions.onTransfer({ kind: 'snapshot' }); }
      catch { /* old handler throws without rejecting startup */ }
    }
    await turn();
    assert.equal(failure, error);
    assert.equal(closes, 1);
    assert.equal(network.isReady(), false);
  });
}
'''
write('scripts/test-filled-board-join.mjs', s)

expected = {
    'package.json': 'f51a59a42e233b88f8e9d48b15420c6512d0e278',
    'src/durableEditGate.js': '8fb291584334e8082252701bb0f5405ae899e630',
    'src/lib/browserBoardSession.js': '853755048dd3874601d87eeca01b11d0ddb920be',
    'src/lib/peerDataChannel.js': '1a29e7fc35d41bf0a900c123653f3b726fabff6b',
    'src/lib/peerProtocol.js': '8e3e7391f3072ef85d268999c22e12109b4daa82',
    'src/lib/studentPeerNetwork.js': 'f99c39adba338c7d8a3af7eb26874e4b54042585',
    'src/lib/teacherPeerNetwork.js': '13ebac3017805707699be9727aad064c05a8fe06',
    'scripts/test-filled-board-join.mjs': 'b1143233287493ff80e0bc344337e325cf618f79',
}
for name, sha in expected.items():
    actual = subprocess.check_output(['git', 'hash-object', name], text=True).strip()
    if actual != sha:
        raise RuntimeError(f'Tested byte mismatch for {name}: {actual} != {sha}')
    print(name, 'verified')
subprocess.run(['git', 'diff', '--check'], check=True)
