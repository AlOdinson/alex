function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Mobile download handlers may consume the blob after the click task.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function drawBackground(context, width, height, background, spacing = 64) {
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  if (background === 'blank') return;
  context.save();
  context.strokeStyle = 'rgba(148,163,184,0.32)';
  context.fillStyle = 'rgba(100,116,139,0.42)';
  if (background === 'grid') {
    context.lineWidth = 1;
    for (let x = 0; x <= width; x += spacing) {
      context.beginPath();
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, height);
      context.stroke();
    }
    for (let y = 0; y <= height; y += spacing) {
      context.beginPath();
      context.moveTo(0, y + 0.5);
      context.lineTo(width, y + 0.5);
      context.stroke();
    }
  } else {
    for (let x = 0; x <= width; x += spacing) {
      for (let y = 0; y <= height; y += spacing) {
        context.beginPath();
        context.arc(x, y, 1.5, 0, Math.PI * 2);
        context.fill();
      }
    }
  }
  context.restore();
}

export function fitExportSize(width, height, multiplier = 2) {
  if (![width, height, multiplier].every(value => Number.isFinite(value) && value > 0)) {
    throw new Error('Некорректный размер экспорта доски');
  }
  const pixelScale = Math.sqrt(8_000_000) / (Math.sqrt(width) * Math.sqrt(height));
  const scale = Math.min(multiplier, 4096 / width, 4096 / height, pixelScale);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    multiplier: scale,
  };
}

export function renderFabricCanvas(canvas, background, { wholeBoard = false, multiplier = 2 } = {}) {
  const include = object => !object.excludeFromExport && !object.transientPreview && !object.transientSelectionProxy;
  const objects = canvas.getObjects().filter(include);
  let width = canvas.getWidth();
  let height = canvas.getHeight();
  let viewport = canvas.viewportTransform;
  if (wholeBoard && objects.length) {
    const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const object of objects) {
      const rect = object.getBoundingRect();
      if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) {
        throw new Error('Некорректный размер объекта при экспорте');
      }
      bounds.left = Math.min(bounds.left, rect.left);
      bounds.top = Math.min(bounds.top, rect.top);
      bounds.right = Math.max(bounds.right, rect.left + rect.width);
      bounds.bottom = Math.max(bounds.bottom, rect.top + rect.height);
    }
    width = Math.max(320, bounds.right - bounds.left + 160);
    height = Math.max(240, bounds.bottom - bounds.top + 160);
    viewport = [1, 0, 0, 1, 80 - bounds.left, 80 - bounds.top];
  }
  const size = fitExportSize(width, height, multiplier);
  const output = document.createElement('canvas');
  let layer;
  const originalViewport = canvas.viewportTransform;
  const originalWidth = canvas.width;
  const originalHeight = canvas.height;
  const originalRetina = canvas.enableRetinaScaling;
  const originalControls = canvas.skipControlsDrawing;
  try {
    output.width = size.width;
    output.height = size.height;
    const context = output.getContext('2d');
    if (!context) throw new Error('Недостаточно памяти для экспорта. Попробуйте PNG текущей области.');
    drawBackground(context, size.width, size.height, background, Math.max(8, 32 * size.multiplier));
    // toCanvasElement draws without selection controls. Do not discard the live
    // selection: that would release leases and can trigger a durable transform.
    canvas.viewportTransform = viewport;
    layer = canvas.toCanvasElement(size.multiplier, { left: 0, top: 0, width, height, filter: include });
    if (!layer?.width || !layer?.height) throw new Error('Не удалось создать изображение доски');
    context.drawImage(layer, 0, 0, output.width, output.height);
    return output;
  } catch (error) {
    output.width = output.height = 0;
    throw error;
  } finally {
    canvas.viewportTransform = originalViewport;
    if (originalWidth != null) canvas.width = originalWidth;
    if (originalHeight != null) canvas.height = originalHeight;
    canvas.enableRetinaScaling = originalRetina;
    canvas.skipControlsDrawing = originalControls;
    canvas.calcViewportBoundaries?.();
    if (layer) layer.width = layer.height = 0;
    canvas.requestRenderAll();
  }
}

export async function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Не удалось создать PNG'));
    }, 'image/png');
  });
}

function dataUrlBytes(dataUrl) {
  if (typeof dataUrl !== 'string' || !/^data:image\/jpeg;base64,.+/.test(dataUrl)) throw new Error('Не удалось создать JPEG для PDF: пустое изображение');
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function asciiBytes(value) {
  return new TextEncoder().encode(value);
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function canvasToPdfBlob(canvas, title = 'Alex Board') {
  const jpeg = dataUrlBytes(canvas.toDataURL('image/jpeg', 0.92));
  const landscape = canvas.width > canvas.height;
  const pageWidth = landscape ? 842 : 595;
  const pageHeight = landscape ? 595 : 842;
  const scale = Math.min(pageWidth / canvas.width, pageHeight / canvas.height);
  const imageWidth = canvas.width * scale;
  const imageHeight = canvas.height * scale;
  const imageX = (pageWidth - imageWidth) / 2;
  const imageY = (pageHeight - imageHeight) / 2;
  const content = `q\n${imageWidth.toFixed(2)} 0 0 ${imageHeight.toFixed(2)} ${imageX.toFixed(2)} ${imageY.toFixed(2)} cm\n/Im0 Do\nQ\n`;

  const objects = [
    asciiBytes('<< /Type /Catalog /Pages 2 0 R >>'),
    asciiBytes('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    asciiBytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`),
    concatBytes([
      asciiBytes(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
      jpeg,
      asciiBytes('\nendstream'),
    ]),
    asciiBytes(`<< /Length ${asciiBytes(content).length} >>\nstream\n${content}endstream`),
    asciiBytes(`<< /Title (${String(title).replace(/[()\\]/g, '')}) /Producer (Alex Board) >>`),
  ];

  const parts = [asciiBytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  const offsets = [0];
  let cursor = parts[0].length;
  objects.forEach((object, index) => {
    offsets.push(cursor);
    const wrapped = concatBytes([
      asciiBytes(`${index + 1} 0 obj\n`),
      object,
      asciiBytes('\nendobj\n'),
    ]);
    parts.push(wrapped);
    cursor += wrapped.length;
  });
  const xrefOffset = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  parts.push(asciiBytes(xref));
  return new Blob([concatBytes(parts)], { type: 'application/pdf' });
}

export function downloadCanvasPng(canvas, filename) {
  return canvasToPngBlob(canvas).then((blob) => downloadBlob(blob, filename));
}

export function downloadCanvasPdf(canvas, filename, title) {
  downloadBlob(canvasToPdfBlob(canvas, title), filename);
}

export async function copyCanvasPng(canvas) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('Этот браузер не поддерживает копирование изображения');
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': canvasToPngBlob(canvas) })]);
}

export async function shareCanvasPng(canvas, filename, title) {
  const blob = await canvasToPngBlob(canvas);
  const file = new File([blob], filename, { type: 'image/png' });
  if (!navigator.share || !navigator.canShare?.({ files: [file] })) {
    downloadBlob(blob, filename);
    return false;
  }
  try {
    await navigator.share({ title, files: [file] });
    return true;
  } catch (error) {
    if (error?.name !== 'NotAllowedError') throw error;
    downloadBlob(blob, filename);
    return false;
  }
}
