import fs from 'node:fs';

const media = fs.readFileSync(new URL('../src/lib/boardScreenShare.js', import.meta.url), 'utf8');
const board = fs.readFileSync(new URL('../src/components/Board.jsx', import.meta.url), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  media.includes("document.createElement('canvas')") && media.includes('frameCanvas'),
  'ShareScreen must render video through a dedicated frame canvas.',
);
assert(
  media.includes('video.videoWidth') && media.includes('video.videoHeight'),
  'ShareScreen must read the real decoded video dimensions.',
);
assert(
  media.includes('frameCanvas.width = sourceWidth') && media.includes('frameCanvas.height = sourceHeight'),
  'Frame canvas must follow decoded video resolution changes.',
);
assert(
  /drawImage\(\s*video,\s*0,\s*0,\s*sourceWidth,\s*sourceHeight\s*\)/s.test(media),
  'Every decoded frame must be fitted completely into the frame canvas.',
);
assert(
  media.includes('object.setElement?.(frameCanvas)') || media.includes('new FabricImage(frameCanvas'),
  'Fabric must display the frame canvas rather than crop directly from the video element.',
);
assert(
  !media.includes('object.setElement?.(video)'),
  'Fabric must not use the live video element directly after the full-frame fix.',
);
assert(
  media.includes("setDiagonalResizeControls(object)") && media.includes('scaleX: uniformScale') && media.includes('scaleY: uniformScale'),
  'ShareScreen must keep diagonal-only proportional resize.',
);

assert(
  board.includes('finishBoardScreenSharePointerTransform'),
  'Board must have an explicit ShareScreen pointer-release finalizer.',
);
assert(
  /window\.addEventListener\(['"]pointerup['"],\s*finishBoardScreenSharePointerTransform/.test(board),
  'Board must finish a ShareScreen drag even when Fabric misses pointerup.',
);
assert(
  /window\.addEventListener\(['"]pointercancel['"],\s*finishBoardScreenSharePointerTransform/.test(board),
  'Board must finish a ShareScreen drag on pointercancel.',
);
assert(
  board.includes('canvas.endCurrentTransform') && board.includes('isBoardScreenShareObject(canvas._currentTransform?.target)'),
  'ShareScreen pointer release must terminate Fabric current transform explicitly.',
);
assert(
  /window\.removeEventListener\(['"]pointerup['"],\s*finishBoardScreenSharePointerTransform/.test(board)
    && /window\.removeEventListener\(['"]pointercancel['"],\s*finishBoardScreenSharePointerTransform/.test(board),
  'ShareScreen release listeners must be cleaned up.',
);

console.log('ShareScreen full-frame and pointer-release regression passed.');
