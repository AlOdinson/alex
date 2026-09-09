export function getFullscreenElement(doc = globalThis.document) {
  if (!doc) return null;
  return doc.fullscreenElement
    ?? doc.webkitFullscreenElement
    ?? doc.mozFullScreenElement
    ?? doc.msFullscreenElement
    ?? null;
}

function firstMethod(target, names) {
  for (const name of names) {
    if (typeof target?.[name] === 'function') return target[name].bind(target);
  }
  return null;
}

export async function enterNativeFullscreen(doc = globalThis.document, target = doc?.documentElement) {
  if (!doc || !target) return false;
  const request = firstMethod(target, [
    'requestFullscreen',
    'webkitRequestFullscreen',
    'webkitRequestFullScreen',
    'mozRequestFullScreen',
    'msRequestFullscreen',
  ]);
  if (!request) return false;
  try {
    const result = request();
    if (result && typeof result.then === 'function') await result;
    return true;
  } catch {
    return false;
  }
}

export async function exitNativeFullscreen(doc = globalThis.document) {
  if (!doc) return false;
  const exit = firstMethod(doc, [
    'exitFullscreen',
    'webkitExitFullscreen',
    'webkitCancelFullScreen',
    'mozCancelFullScreen',
    'msExitFullscreen',
  ]);
  if (!exit) return false;
  try {
    const result = exit();
    if (result && typeof result.then === 'function') await result;
    return true;
  } catch {
    return false;
  }
}
