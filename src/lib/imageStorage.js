const MAX_SIDE = 1800;
const TARGET_MAX_BYTES = Math.floor(4.5 * 1024 * 1024);
const ACCEPTED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif']);

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function fileExtension(name = '') {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

export function isHeicFile(file) {
  const extension = fileExtension(file?.name);
  const mime = String(file?.type ?? '').toLowerCase();
  return extension === 'heic'
    || extension === 'heif'
    || mime === 'image/heic'
    || mime === 'image/heif'
    || mime === 'image/heic-sequence'
    || mime === 'image/heif-sequence';
}

export function isAcceptedImageFile(file) {
  if (!file) return false;
  if (String(file.type ?? '').toLowerCase().startsWith('image/')) return true;
  return ACCEPTED_EXTENSIONS.has(fileExtension(file.name));
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Браузер не смог подготовить изображение'));
      },
      type,
      quality,
    );
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Не удалось прочитать изображение'));
    reader.readAsDataURL(blob);
  });
}

function abortError() {
  return new DOMException('Загрузка изображения отменена', 'AbortError');
}

function sleep(milliseconds, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const cancel = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

function withRetryToken(source, attempt) {
  if (!/^https?:/i.test(source) || attempt <= 0) return source;
  const separator = source.includes('?') ? '&' : '?';
  return `${source}${separator}alex_retry=${Date.now()}-${attempt}`;
}

export async function loadImageElement(source, { retries = 1, timeoutMs = 8_000, signal } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw abortError();
    try {
      const requestSource = withRetryToken(source, attempt);
      // eslint-disable-next-line no-await-in-loop
      return await new Promise((resolve, reject) => {
        const image = new Image();
        let settled = false;
        let timer;
        const finish = (error = null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          image.onload = null;
          image.onerror = null;
          signal?.removeEventListener('abort', cancel);
          if (error) {
            image.removeAttribute?.('src');
            reject(error);
          } else resolve(image);
        };
        const cancel = () => finish(abortError());
        if (/^https?:/i.test(requestSource)) image.crossOrigin = 'anonymous';
        image.decoding = 'async';
        // onload already confirms usable pixels. Waiting for a second decode()
        // promise here can deadlock the whole authoritative Canvas queue.
        image.onload = () => finish();
        image.onerror = () => finish(new Error('Не удалось загрузить изображение'));
        timer = setTimeout(() => finish(new Error('Истекло время загрузки изображения')),
          Math.max(1, Number(timeoutMs) || 8_000));
        signal?.addEventListener('abort', cancel, { once: true });
        try { image.src = requestSource; } catch (error) { finish(error); }
        if (signal?.aborted) cancel();
      });
    } catch (caught) {
      if (caught?.name === 'AbortError' || signal?.aborted) throw caught;
      lastError = caught;
      if (attempt < retries) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(Math.min(1800, 260 * (attempt + 1)), signal);
      }
    }
  }
  throw lastError ?? new Error('Не удалось загрузить изображение');
}

// Fabric has its own image requests. A native pre-load timeout alone cannot
// release those requests, so propagate cancellation into enlivenObjects too.
export async function enlivenBoardObjects(enliven, objects, { timeoutMs = 8_000 } = {}) {
  const sources = new Set();
  collectImageSources(objects, sources);
  if (!sources.size) return enliven(objects);
  const controller = new AbortController();
  let expired = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      const error = new Error('Истекло время отображения изображения');
      reject(error);
      controller.abort();
    }, Math.max(1, Number(timeoutMs) || 8_000));
  });
  const task = Promise.resolve().then(() => enliven(objects, { signal: controller.signal }))
    .then((revived) => {
      if (expired) revived?.forEach((object) => object?.dispose?.());
      return revived;
    });
  try { return await Promise.race([task, timeout]); }
  finally { clearTimeout(timer); }
}

async function decodeBlob(blob) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await loadImageElement(objectUrl, { retries: 0 });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function convertHeicToJpeg(file) {
  const { heicTo } = await import('heic-to/csp');
  const result = await heicTo({
    blob: file,
    type: 'image/jpeg',
    quality: 0.92,
  });
  if (Array.isArray(result)) return result[0];
  return result;
}

function chooseOutputType(file, sourceBlob) {
  const extension = fileExtension(file?.name);
  const mime = String(sourceBlob?.type || file?.type || '').toLowerCase();
  if (extension === 'png' || mime === 'image/png') {
    return { contentType: 'image/png', extension: 'png', quality: undefined };
  }
  if (extension === 'webp' || mime === 'image/webp') {
    return { contentType: 'image/webp', extension: 'webp', quality: 0.9 };
  }
  return { contentType: 'image/jpeg', extension: 'jpg', quality: 0.88 };
}

export async function prepareImageForBoard(file) {
  if (!isAcceptedImageFile(file)) {
    throw new Error('Поддерживаются JPG, PNG, WebP, GIF, HEIC и HEIF');
  }

  let sourceBlob = file;
  let convertedFromHeic = false;
  if (isHeicFile(file)) {
    sourceBlob = await convertHeicToJpeg(file);
    convertedFromHeic = true;
  }

  const image = await decodeBlob(sourceBlob);
  const naturalWidth = Number(image.naturalWidth || image.width || 1);
  const naturalHeight = Number(image.naturalHeight || image.height || 1);
  let scale = Math.min(1, MAX_SIDE / Math.max(naturalWidth, naturalHeight));
  let width = Math.max(1, Math.round(naturalWidth * scale));
  let height = Math.max(1, Math.round(naturalHeight * scale));
  const output = chooseOutputType(file, sourceBlob);
  if (convertedFromHeic) {
    output.contentType = 'image/jpeg';
    output.extension = 'jpg';
    output.quality = 0.88;
  }

  let resultBlob = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: output.contentType !== 'image/jpeg' });
    if (!context) throw new Error('Не удалось подготовить изображение');
    if (output.contentType === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    } else {
      context.clearRect(0, 0, width, height);
    }
    context.drawImage(image, 0, 0, width, height);
    // eslint-disable-next-line no-await-in-loop
    resultBlob = await canvasToBlob(canvas, output.contentType, output.quality);
    if (resultBlob.size <= TARGET_MAX_BYTES || Math.max(width, height) <= 720) break;
    width = Math.max(320, Math.round(width * 0.82));
    height = Math.max(240, Math.round(height * 0.82));
    if (typeof output.quality === 'number') output.quality = Math.max(0.7, output.quality - 0.05);
  }

  if (!resultBlob) throw new Error('Не удалось подготовить изображение');
  const actualContentType = resultBlob.type || output.contentType;
  const actualExtension = actualContentType === 'image/png'
    ? 'png'
    : actualContentType === 'image/webp'
      ? 'webp'
      : 'jpg';
  return {
    blob: resultBlob,
    contentType: actualContentType,
    extension: actualExtension,
    width,
    height,
    convertedFromHeic,
  };
}

export async function storeBoardImage(boardId, file) {
  // Keep the public call signature stable for Board.jsx. The board id is no longer
  // needed because the compressed bytes live inside the browser-authoritative object.
  void boardId;
  const prepared = await prepareImageForBoard(file);
  return {
    url: await blobToDataUrl(prepared.blob),
    storagePath: null,
    ...prepared,
  };
}

function collectImageSources(value, results) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectImageSources(item, results));
    return;
  }
  const type = String(value.type ?? '').toLowerCase();
  if ((type === 'image' || value.objectKind === 'image') && typeof value.src === 'string') {
    results.add(value.src);
  }
  Object.values(value).forEach((item) => collectImageSources(item, results));
}

export async function preloadSerializedImages(value) {
  const sources = new Set();
  collectImageSources(value, sources);
  const queue = [...sources];
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const source = queue.shift();
      if (!source) continue;
      // eslint-disable-next-line no-await-in-loop
      await loadImageElement(source, { retries: 0 });
    }
  });
  await Promise.all(workers);
}

/**
 * Browser-authority images are self-contained data URLs. A cross-board duplicate
 * therefore needs only a defensive clone; no network fetch or second upload exists.
 */
export async function copySerializedBoardImages(value, targetBoardId) {
  void targetBoardId;
  return cloneValue(value);
}

/** Retry an uncertain transport outcome, never a rejected authoritative result.
 * The caller closes over a fixed actionId and the exact same serialized bytes.
 */
export async function publishBoardImage(publish, {
  isActive = () => true, delay = (ms) => sleep(ms), onRetry = () => {},
} = {}) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!isActive()) throw abortError();
    let results;
    try {
      // eslint-disable-next-line no-await-in-loop
      results = await publish();
    } catch (error) {
      if (attempt === 2 || !/timed out|closed|connection|runtime|network|peer/i.test(String(error?.message))) throw error;
      onRetry(attempt + 1);
      // eslint-disable-next-line no-await-in-loop
      await delay(1_000 * (attempt + 1));
      continue;
    }
    if (!Array.isArray(results) || !results.length || results.some((result) => !result || result.accepted === false)) {
      const reason = results?.find?.((result) => result?.error)?.error;
      throw new Error(reason || 'Не удалось подтвердить сохранение изображения');
    }
    return results;
  }
}
