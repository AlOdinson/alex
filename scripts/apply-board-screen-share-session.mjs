import fs from 'node:fs';

const path = new URL('../src/components/ScreenShare.jsx', import.meta.url);
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`Patch target not found: ${label}`);
  source = source.replace(before, after);
}

replaceOnce(
  `  normalizeRemoteBrowserState,\n  normalizeScreenShareSignal,`,
  `  normalizeRemoteBrowserState,\n  normalizeScreenShareBoardLayout,\n  normalizeScreenShareSignal,`,
  'layout import',
);
replaceOnce(
  `  screenShareNetworkIsDegraded,\n  screenShareProfileForActivity,`,
  `  screenShareNetworkIsDegraded,\n  screenSharePermissionCanHost,\n  screenShareProfileForActivity,`,
  'permission import',
);
replaceOnce(
  `  boardRealtimeKey,\n  teacherAccountKey,\n}) {`,
  `  boardRealtimeKey,\n  teacherAccountKey,\n  getInitialBoardLayout,\n}) {`,
  'hook initial layout parameter',
);
replaceOnce(
  `  const [view, setView] = useState({\n    phase: 'idle',\n    role: null,`,
  `  const [view, setView] = useState({\n    phase: 'idle',\n    role: null,\n    sessionId: '',\n    boardLayout: null,`,
  'initial view session state',
);
replaceOnce(
  `    sendSignal('host-start', {\n      startedAt: session.startedAt,\n      hostName: participantName,\n      sourceMode: session.sourceMode ?? 'screen',`,
  `    sendSignal('host-start', {\n      startedAt: session.startedAt,\n      hostName: participantName,\n      sourceMode: session.sourceMode ?? 'screen',\n      boardLayout: session.boardLayout ?? null,`,
  'host-start layout announcement',
);
replaceOnce(
  `    if (current?.sessionId === candidate.sessionId) {\n      activeSessionRef.current = { ...current, ...candidate };`,
  `    if (current?.sessionId === candidate.sessionId) {\n      activeSessionRef.current = { ...current, ...candidate };\n      if (candidate.boardLayout) updateView({ boardLayout: candidate.boardLayout });`,
  'refresh existing viewer layout',
);
replaceOnce(
  `    updateView({\n      phase: candidate.paused ? 'paused' : 'connecting',\n      role: 'viewer',`,
  `    updateView({\n      phase: candidate.paused ? 'paused' : 'connecting',\n      role: 'viewer',\n      sessionId: candidate.sessionId,\n      boardLayout: candidate.boardLayout ?? null,`,
  'viewer view session state',
);
replaceOnce(
  `    if (HOST_SIGNAL_TYPES.has(signal.type) && signal.permission !== 'owner') return;\n\n    if (signal.type === 'host-start') {`,
  `    if (HOST_SIGNAL_TYPES.has(signal.type)) {\n      const currentSession = activeSessionRef.current;\n      const remoteBrowserHostSignal = signal.sourceMode === 'remote-browser'\n        || (currentSession?.sessionId === signal.sessionId && currentSession?.sourceMode === 'remote-browser');\n      if (remoteBrowserHostSignal\n        ? signal.permission !== 'owner'\n        : !screenSharePermissionCanHost(signal.permission)) return;\n    }\n    if (signal.type === 'screen-layout' && !screenSharePermissionCanHost(signal.permission)) return;\n\n    if (signal.type === 'host-start') {`,
  'editor host signal permission',
);
replaceOnce(
  `        sourceMode: signal.sourceMode === 'remote-browser' ? 'remote-browser' : 'screen',\n        remoteBrowserState: normalizeRemoteBrowserState(signal.remoteBrowserState),`,
  `        sourceMode: signal.sourceMode === 'remote-browser' ? 'remote-browser' : 'screen',\n        boardLayout: normalizeScreenShareBoardLayout(signal.boardLayout),\n        remoteBrowserState: normalizeRemoteBrowserState(signal.remoteBrowserState),`,
  'host-start candidate layout',
);
replaceOnce(
  `    const session = activeSessionRef.current;\n    if (!session || session.sessionId !== signal.sessionId) return;\n\n    if (signal.type === 'host-stop'`,
  `    const session = activeSessionRef.current;\n    if (!session || session.sessionId !== signal.sessionId) return;\n\n    if (signal.type === 'screen-layout') {\n      if (session.sourceMode !== 'screen') return;\n      const layout = normalizeScreenShareBoardLayout(signal.layout);\n      if (!layout) return;\n      activeSessionRef.current = { ...session, boardLayout: layout };\n      updateView({ boardLayout: layout });\n      return;\n    }\n\n    if (signal.type === 'host-stop'`,
  'screen-layout receiver',
);
replaceOnce(
  `  const start = useCallback(async () => {\n    if (!isOwner || startBusyRef.current) return;`,
  `  const start = useCallback(async () => {\n    if (!canEdit || startBusyRef.current) return;`,
  'editor start permission',
);
replaceOnce(
  `      const session = {\n        sessionId: randomToken(18),\n        hostId: clientId,\n        hostName: participantName,\n        startedAt: Date.now(),\n        sourceMode: 'screen',\n      };`,
  `      const boardLayout = normalizeScreenShareBoardLayout(getInitialBoardLayout?.())\n        ?? { left: -320, top: -180, width: 640, height: 360 };\n      const session = {\n        sessionId: randomToken(18),\n        hostId: clientId,\n        hostName: participantName,\n        startedAt: Date.now(),\n        sourceMode: 'screen',\n        boardLayout,\n      };`,
  'host session initial layout',
);
replaceOnce(
  `      updateView({\n        phase: track.muted ? 'paused' : 'hosting',\n        role: 'host',\n        hostName: participantName,`,
  `      updateView({\n        phase: track.muted ? 'paused' : 'hosting',\n        role: 'host',\n        sessionId: session.sessionId,\n        boardLayout: session.boardLayout,\n        hostName: participantName,`,
  'host view session state',
);
replaceOnce(
  `  }, [announceHost, applyCurrentProfile, capability, clientId, isOwner, participantName, sendSignal, updateView]);`,
  `  }, [announceHost, applyCurrentProfile, canEdit, capability, clientId, getInitialBoardLayout, participantName, sendSignal, updateView]);`,
  'start dependencies',
);

const resetPattern = /setView\(\{\n        phase: 'idle',\n        role: null,\n        hostName: '',/g;
source = source.replace(resetPattern, `setView({\n        phase: 'idle',\n        role: null,\n        sessionId: '',\n        boardLayout: null,\n        hostName: '',`);

replaceOnce(
  `  const toggle = useCallback(() => {\n    const session = activeSessionRef.current;\n    if (session?.hostId === clientId) stopHosting('user', true);\n    else start();\n  }, [clientId, start, stopHosting]);`,
  `  const updateBoardLayout = useCallback((nextLayout) => {\n    if (!canEdit) return false;\n    const session = activeSessionRef.current;\n    if (!session || session.sourceMode !== 'screen') return false;\n    const layout = normalizeScreenShareBoardLayout(nextLayout);\n    if (!layout) return false;\n    activeSessionRef.current = { ...session, boardLayout: layout };\n    updateView({ boardLayout: layout });\n    sendSignal('screen-layout', { layout }, session);\n    return true;\n  }, [canEdit, sendSignal, updateView]);\n\n  const toggle = useCallback(() => {\n    const session = activeSessionRef.current;\n    if (session?.hostId === clientId) stopHosting('user', true);\n    else start();\n  }, [clientId, start, stopHosting]);`,
  'board layout updater',
);
replaceOnce(
  `  return {\n    ...view,\n    stream,`,
  `  return {\n    ...view,\n    sessionId: view.sessionId,\n    boardLayout: view.boardLayout,\n    stream,`,
  'hook exposed session state',
);
replaceOnce(
  `    stopRemoteBrowser,\n    toggle,\n    dismiss,`,
  `    stopRemoteBrowser,\n    toggle,\n    updateBoardLayout,\n    dismiss,`,
  'hook exposed layout updater',
);

fs.writeFileSync(path, source);
