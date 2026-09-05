import fs from 'node:fs';

const path = new URL('../src/components/Board.jsx', import.meta.url);
let source = fs.readFileSync(path, 'utf8');

const transformMarker = `    canvas.on('object:skewing', broadcastLiveTransform);\n\n    canvas.on('object:modified', ({ target }) => {`;
const transformReplacement = `    canvas.on('object:skewing', broadcastLiveTransform);\n\n    function finishBoardScreenSharePointerTransform(event) {\n      const transform = canvas._currentTransform;\n      if (!isBoardScreenShareObject(canvas._currentTransform?.target)) return false;\n      const target = transform.target;\n      try {\n        canvas.endCurrentTransform?.(event);\n      } catch {\n        // A lost native release must never leave this transient object attached.\n      }\n      if (canvas._currentTransform === transform) canvas._currentTransform = null;\n      try {\n        if (event?.pointerId != null && canvas.upperCanvasEl?.hasPointerCapture?.(event.pointerId)) {\n          canvas.upperCanvasEl.releasePointerCapture(event.pointerId);\n        }\n      } catch {\n        // Pointer capture may already have been released by the browser.\n      }\n      restoreTargetFindAfterTransform();\n      target.set({ angle: 0, skewX: 0, skewY: 0, flipX: false, flipY: false });\n      target.setCoords();\n      broadcastBoardScreenShareLayout(target, true);\n      canvas.requestRenderAll();\n      return true;\n    }\n    window.addEventListener('pointerup', finishBoardScreenSharePointerTransform);\n    window.addEventListener('pointercancel', finishBoardScreenSharePointerTransform);\n\n    canvas.on('object:modified', ({ target }) => {`;

if (!source.includes(transformReplacement)) {
  if (!source.includes(transformMarker)) throw new Error('ShareScreen transform insertion point not found');
  source = source.replace(transformMarker, transformReplacement);
}

const cleanupMarker = `      host.removeEventListener('drop', handleDrop);\n      window.clearInterval(syncInterval);`;
const cleanupReplacement = `      host.removeEventListener('drop', handleDrop);\n      window.removeEventListener('pointerup', finishBoardScreenSharePointerTransform);\n      window.removeEventListener('pointercancel', finishBoardScreenSharePointerTransform);\n      window.clearInterval(syncInterval);`;

if (!source.includes(cleanupReplacement)) {
  if (!source.includes(cleanupMarker)) throw new Error('ShareScreen cleanup insertion point not found');
  source = source.replace(cleanupMarker, cleanupReplacement);
}

fs.writeFileSync(path, source);
