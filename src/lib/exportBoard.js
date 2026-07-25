function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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

export function renderFabricCanvas(canvas, background, { wholeBoard = false, multiplier = 2 } = {}) {
  const objects = canvas.getObjects().filter((object) => !object.excludeFromExport);
  let left = 0;
  let top = 0;
  let width = canvas.getWidth();
  let height = canvas.getHeight();
  let viewportTransform = canvas.viewportTransform;

  if (wholeBoard && objects.length) {
    const bounds = objects.reduce((result, object) => {
      const rect = object.getBoundingRect(true, true);
      return {
        left: Math.min(result.left, rect.left),
        top: Math.min(result.top, rect.top),
        right: Math.max(result.right, rect.left + rect.width),
        bottom: Math.max(result.bottom, rect.top + rect.height),
      };
    }, { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    const padding = 80;
    left = bounds.left - padding;
    top = bounds.top - padding;
    width = Math.max(320, bounds.right - bounds.left + padding * 2);
    height = Math.max(240, bounds.bottom - bounds.top + padding * 2);
    viewportTransform = [1, 0, 0, 1, -left, -top];
  }

  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = Math.max(1, Math.round(width * multiplier));
  exportCanvas.height = Math.max(1, Math.round(height * multiplier));
  const context = exportCanvas.getContext('2d');
  drawBackground(context, exportCanvas.width, exportCanvas.height, background, 32 * multiplier);

  const originalViewport = canvas.viewportTransform;
  const originalWidth = canvas.getWidth();
  const originalHeight = canvas.getHeight();
  const originalSelection = canvas.getActiveObject();
  canvas.discardActiveObject();
  try {
    canvas.setViewportTransform(viewportTransform);
    const objectLayer = canvas.toCanvasElement(multiplier, {
      left: 0,
      top: 0,
      width,
      height,
      enableRetinaScaling: false,
    });
    context.drawImage(objectLayer, 0, 0);
  } finally {
    canvas.setDimensions({ width: originalWidth, height: originalHeight });
    canvas.setViewportTransform(originalViewport);
    if (originalSelection) canvas.setActiveObject(originalSelection);
    canvas.requestRenderAll();
  }
  return exportCanvas;
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
  const blob = await canvasToPngBlob(canvas);
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('Этот браузер не поддерживает копирование изображения');
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

export async function shareCanvasPng(canvas, filename, title) {
  const blob = await canvasToPngBlob(canvas);
  const file = new File([blob], filename, { type: 'image/png' });
  if (!navigator.share || !navigator.canShare?.({ files: [file] })) {
    downloadBlob(blob, filename);
    return false;
  }
  await navigator.share({ title, files: [file] });
  return true;
}
