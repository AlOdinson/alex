from pathlib import Path


def replace_once(path, old, new):
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected exactly one match, found {count}: {old[:80]!r}')
    file.write_text(text.replace(old, new, 1))


replace_once(
    'src/lib/peerDataChannel.js',
    '  const waitForBufferSpace = () => {',
    '  const waitForBufferSpace = (timeoutMs = writeTimeoutMs) => {',
)
replace_once(
    'src/lib/peerDataChannel.js',
    '      const delay = Number(writeTimeoutMs);\n      const stallDelay = Number.isFinite(delay) && delay > 0 ? delay : 30_000;\n      const pollDelay = Math.max(10, Math.min(250, Math.floor(stallDelay / 10)));',
    '      const delay = Number(timeoutMs);\n      const stallDelay = Number.isFinite(delay) && delay > 0 ? delay : 30_000;\n      const pollDelay = Math.max(10, Math.min(250, Math.floor(stallDelay / 10)));',
)
replace_once(
    'src/lib/peerDataChannel.js',
    "  const waitForWritable = async () => {\n    await waitFor('open', () => channel.readyState === 'open', 'Peer data channel closed before opening');\n    if (Number(channel.bufferedAmount ?? 0) <= highWater) return;\n    await waitForBufferSpace();\n  };",
    "  const waitForWritable = async (timeoutMs = writeTimeoutMs) => {\n    await waitFor('open', () => channel.readyState === 'open', 'Peer data channel closed before opening');\n    if (Number(channel.bufferedAmount ?? 0) <= highWater) return;\n    await waitForBufferSpace(timeoutMs);\n  };",
)
replace_once(
    'src/lib/peerDataChannel.js',
    "  const enqueueEncodedFrames = (frames) => {\n    const task = sendQueue.then(async () => {\n      for (const frame of frames) {\n        if (closed) throw new Error('Peer data channel transport is closed');\n        // eslint-disable-next-line no-await-in-loop\n        await waitForWritable();",
    "  const enqueueEncodedFrames = (frames, { writeTimeoutMs: frameWriteTimeoutMs = writeTimeoutMs } = {}) => {\n    const task = sendQueue.then(async () => {\n      for (const frame of frames) {\n        if (closed) throw new Error('Peer data channel transport is closed');\n        // eslint-disable-next-line no-await-in-loop\n        await waitForWritable(frameWriteTimeoutMs);",
)
replace_once(
    'src/lib/peerDataChannel.js',
    "    sendTextTransfer(kind, text, options = {}) {\n      const frames = splitPeerTextTransfer(kind, text, options)\n        .map((frame) => JSON.stringify(frame));\n      return enqueueEncodedFrames(frames);\n    },",
    "    sendTextTransfer(kind, text, options = {}) {\n      const {\n        writeTimeoutMs: transferWriteTimeoutMs = writeTimeoutMs,\n        ...transferOptions\n      } = options;\n      const frames = splitPeerTextTransfer(kind, text, transferOptions)\n        .map((frame) => JSON.stringify(frame));\n      return enqueueEncodedFrames(frames, { writeTimeoutMs: transferWriteTimeoutMs });\n    },",
)

replace_once(
    'src/lib/teacherPeerHub.js',
    "import { createTeacherObjectLockAuthority } from './teacherObjectLocks.js';\n\nfunction defaultTransferId()",
    "import { createTeacherObjectLockAuthority } from './teacherObjectLocks.js';\n\nconst SNAPSHOT_WRITE_TIMEOUT_MS = 120_000;\n\nfunction defaultTransferId()",
)
replace_once(
    'src/lib/teacherPeerHub.js',
    '  createTransferId = defaultTransferId,\n  maxJournalCommits = 256,\n  onCommit = () => {},',
    '  createTransferId = defaultTransferId,\n  maxJournalCommits = 256,\n  snapshotWriteTimeoutMs = SNAPSHOT_WRITE_TIMEOUT_MS,\n  onCommit = () => {},',
)
replace_once(
    'src/lib/teacherPeerHub.js',
    '  const peers = new Map();\n  const journalLimit = Math.max(1, Number(maxJournalCommits) || 256);',
    "  const peers = new Map();\n  const journalLimit = Math.max(1, Number(maxJournalCommits) || 256);\n  const snapshotTimeout = Number.isFinite(Number(snapshotWriteTimeoutMs)) && Number(snapshotWriteTimeoutMs) > 0\n    ? Number(snapshotWriteTimeoutMs)\n    : SNAPSHOT_WRITE_TIMEOUT_MS;",
)
replace_once(
    'src/lib/teacherPeerHub.js',
    "    await peer.sendTextTransfer('snapshot', payload, {\n      transferId: createTransferId(),\n    });",
    "    await peer.sendTextTransfer('snapshot', payload, {\n      transferId: createTransferId(),\n      writeTimeoutMs: snapshotTimeout,\n    });",
)

replace_once(
    'src/lib/studentPeerNetwork.js',
    'const INITIAL_SYNC_IDLE_TIMEOUT_MS = 30_000;',
    'const INITIAL_SYNC_IDLE_TIMEOUT_MS = 90_000;',
)
