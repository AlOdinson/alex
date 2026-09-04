import fs from 'node:fs';

const path = new URL('../src/components/Board.jsx', import.meta.url);
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`Patch target not found: ${label}`);
  source = source.replace(before, after);
}

function patchSection(startMarker, endMarker, transform, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Section start not found: ${label}`);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`Section end not found: ${label}`);
  const original = source.slice(start, end);
  const next = transform(original);
  if (next === original) throw new Error(`Section did not change: ${label}`);
  source = `${source.slice(0, start)}${next}${source.slice(end)}`;
}

replaceOnce(
  `import { createShape } from '../lib/shapes.js';\n`,
  `import { createShape } from '../lib/shapes.js';\nimport { screenShareBoardLayoutForViewport } from '../lib/screenShare.js';\nimport {\n  createBoardScreenShareMedia,\n  isBoardScreenShareObject,\n  screenShareLayoutFromFabricObject,\n} from '../lib/boardScreenShare.js';\n`,
  'screen-share imports',
);

replaceOnce(
  `  'selectionSourceIds',\n  'textPlaceholder',`,
  `  'selectionSourceIds',\n  'transientScreenShare',\n  'screenShareSessionId',\n  'textPlaceholder',`,
  'Fabric custom properties',
);

if (!source.includes('const boardScreenShareRef = useRef(null);')) {
  replaceOnce(
    `  const viewSendRef = useRef({ lastSentAt: 0, timer: null, pending: false });\n`,
    `  const viewSendRef = useRef({ lastSentAt: 0, timer: null, pending: false });\n  const boardScreenShareRef = useRef(null);\n  const screenShareRef = useRef(null);\n  const screenShareLayoutSendRef = useRef({ lastSentAt: 0, timer: null, pending: null });\n`,
    'screen-share refs',
  );
}

if (!source.includes('const getInitialScreenShareBoardLayout = useCallback')) {
  replaceOnce(
    `  const isOwner = permission === 'owner';\n  const canEdit = permission === 'owner' || permission === 'edit';\n  const screenShare = useAdaptiveScreenShare({`,
    `  const isOwner = permission === 'owner';\n  const canEdit = permission === 'owner' || permission === 'edit';\n  const getInitialScreenShareBoardLayout = useCallback(() => {\n    const canvas = fabricCanvasRef.current;\n    if (!canvas) return null;\n    const viewportTransform = canvas.viewportTransform ?? [1, 0, 0, 1, 0, 0];\n    const inverse = util.invertTransform(viewportTransform);\n    const center = util.transformPoint(\n      new Point(canvas.getWidth() / 2, canvas.getHeight() / 2),\n      inverse,\n    );\n    return screenShareBoardLayoutForViewport({\n      centerX: center.x,\n      centerY: center.y,\n      viewportWidth: canvas.getWidth(),\n      viewportHeight: canvas.getHeight(),\n      zoom: canvas.getZoom(),\n    });\n  }, []);\n  const screenShare = useAdaptiveScreenShare({`,
    'initial screen-share board layout',
  );
}

replaceOnce(
  `    boardRealtimeKey: initialAccess.realtimeKey,\n    teacherAccountKey,\n  });\n  screenShareSignalHandlerRef.current = screenShare.handleSignal;`,
  `    boardRealtimeKey: initialAccess.realtimeKey,\n    teacherAccountKey,\n    getInitialBoardLayout: getInitialScreenShareBoardLayout,\n  });\n  screenShareRef.current = screenShare;\n  screenShareSignalHandlerRef.current = screenShare.handleSignal;`,
  'screen-share hook integration',
);

if (!source.includes('const broadcastBoardScreenShareLayout = useCallback')) {
  replaceOnce(
    `  screenShareRef.current = screenShare;\n  screenShareSignalHandlerRef.current = screenShare.handleSignal;\n`,
    `  screenShareRef.current = screenShare;\n  screenShareSignalHandlerRef.current = screenShare.handleSignal;\n\n  const broadcastBoardScreenShareLayout = useCallback((target, immediate = false) => {\n    if (!isBoardScreenShareObject(target)) return;\n    const layout = screenShareLayoutFromFabricObject(target);\n    if (!layout) return;\n    const state = screenShareLayoutSendRef.current;\n    const send = (nextLayout) => {\n      state.lastSentAt = Date.now();\n      state.pending = null;\n      screenShareRef.current?.updateBoardLayout?.(nextLayout);\n    };\n    if (immediate) {\n      if (state.timer) window.clearTimeout(state.timer);\n      state.timer = null;\n      send(layout);\n      return;\n    }\n    const elapsed = Date.now() - state.lastSentAt;\n    if (elapsed >= LIVE_TRANSFORM_INTERVAL && !state.timer) {\n      send(layout);\n      return;\n    }\n    state.pending = layout;\n    if (state.timer) return;\n    state.timer = window.setTimeout(() => {\n      state.timer = null;\n      const pending = state.pending;\n      if (pending) send(pending);\n    }, Math.max(0, LIVE_TRANSFORM_INTERVAL - elapsed));\n  }, []);\n\n  useEffect(() => {\n    const canvas = fabricCanvasRef.current;\n    const active = Boolean(screenShare.sessionId && screenShare.sourceMode === 'screen');\n    let controller = boardScreenShareRef.current;\n\n    const removeController = () => {\n      controller = boardScreenShareRef.current;\n      if (!controller) return;\n      if (canvas?.getActiveObject?.() === controller.object) canvas.discardActiveObject?.();\n      if (controller.object?.canvas) controller.object.canvas.remove(controller.object);\n      controller.dispose();\n      boardScreenShareRef.current = null;\n    };\n\n    if (!active || !canvas) {\n      removeController();\n      canvas?.requestRenderAll?.();\n      return;\n    }\n\n    if (!controller || controller.object?.screenShareSessionId !== screenShare.sessionId) {\n      removeController();\n      controller = createBoardScreenShareMedia({\n        sessionId: screenShare.sessionId,\n        layout: screenShare.boardLayout,\n        canEdit,\n      });\n      boardScreenShareRef.current = controller;\n      canvas.add(controller.object);\n    }\n\n    controller.setInteractive(canEdit);\n    controller.setStream(screenShare.stream);\n    const locallyTransforming = canvas._currentTransform?.target === controller.object;\n    if (screenShare.boardLayout && !locallyTransforming) {\n      controller.setLayout(screenShare.boardLayout);\n    }\n    canvas.requestRenderAll();\n  }, [canEdit, screenShare.boardLayout, screenShare.sessionId, screenShare.sourceMode, screenShare.stream]);\n\n  useEffect(() => () => {\n    const sendState = screenShareLayoutSendRef.current;\n    if (sendState.timer) window.clearTimeout(sendState.timer);\n    sendState.timer = null;\n    sendState.pending = null;\n    const controller = boardScreenShareRef.current;\n    if (controller) {\n      if (controller.object?.canvas) controller.object.canvas.remove(controller.object);\n      controller.dispose();\n      boardScreenShareRef.current = null;\n    }\n  }, []);\n`,
    'screen-share board object lifecycle',
  );
}

if (!source.includes('if (isBoardScreenShareObject(transform.target)) {')) {
  replaceOnce(
    `    canvas.on('before:transform', ({ transform, e: nativeEvent }) => {\n      if (applyingRemoteRef.current || applyingHistoryRef.current || !transform?.target) return;\n`,
    `    canvas.on('before:transform', ({ transform, e: nativeEvent }) => {\n      if (applyingRemoteRef.current || applyingHistoryRef.current || !transform?.target) return;\n      if (isBoardScreenShareObject(transform.target)) {\n        modifiedBeforeRecordsRef.current = [];\n        currentTransformStartRef.current = null;\n        currentTransformMovedRef.current = false;\n        return;\n      }\n`,
    'before transform transient screen share',
  );
}

if (!source.includes('broadcastBoardScreenShareLayout(target, false);')) {
  replaceOnce(
    `    const broadcastLiveTransform = ({ target }) => {\n      if (!target || applyingRemoteRef.current || applyingHistoryRef.current) return;\n`,
    `    const broadcastLiveTransform = ({ target }) => {\n      if (!target || applyingRemoteRef.current || applyingHistoryRef.current) return;\n      if (isBoardScreenShareObject(target)) {\n        target.set({ angle: 0, skewX: 0, skewY: 0, flipX: false, flipY: false });\n        target.setCoords();\n        broadcastBoardScreenShareLayout(target, false);\n        return;\n      }\n`,
    'live screen-share transform broadcast',
  );
}

if (!source.includes('broadcastBoardScreenShareLayout(target, true);')) {
  replaceOnce(
    `    canvas.on('object:modified', ({ target }) => {\n      restoreTargetFindAfterTransform();\n      if (applyingRemoteRef.current || applyingHistoryRef.current || !target) return;\n`,
    `    canvas.on('object:modified', ({ target }) => {\n      restoreTargetFindAfterTransform();\n      if (applyingRemoteRef.current || applyingHistoryRef.current || !target) return;\n      if (isBoardScreenShareObject(target)) {\n        target.set({ angle: 0, skewX: 0, skewY: 0, flipX: false, flipY: false });\n        target.setCoords();\n        modifiedBeforeRecordsRef.current = [];\n        currentTransformStartRef.current = null;\n        currentTransformMovedRef.current = false;\n        broadcastBoardScreenShareLayout(target, true);\n        canvas.requestRenderAll();\n        return;\n      }\n`,
    'modified screen-share transform commit',
  );
}

// Any toolbar/clipboard/delete path based on active Fabric objects must ignore the
// live media surface. It remains directly transformable on canvas, but never durable.
source = source.replaceAll(
  `.filter((object) => !object.isEraserPath)`,
  `.filter((object) => !object.isEraserPath && !object.transientScreenShare)`,
);

source = source.replaceAll(
  `object.isEraserPath || object.transientPreview || object.transientSelectionProxy || !object.selectable`,
  `object.isEraserPath || object.transientPreview || object.transientSelectionProxy || object.transientScreenShare || !object.selectable`,
);

patchSection(
  `  const clearBoard = useCallback`,
  `  const addShape = useCallback`,
  (section) => {
    if (section.includes(`canvas.getObjects().filter((object) => !object.transientScreenShare)`)) return section;
    const next = section.replace(
      `const objects = canvas.getObjects();`,
      `const objects = canvas.getObjects().filter((object) => !object.transientScreenShare);`,
    );
    if (next === section) throw new Error('clearBoard object list not found');
    return next;
  },
  'clearBoard transient protection',
);

fs.writeFileSync(path, source);
