export function pdfPageGeometry(object, page) {
  const width = Math.max(1, Number(object.width) || 1);
  const sx = Math.abs(Number(object.scaleX) || 1);
  const sy = Math.abs(Number(object.scaleY) || 1);
  return { width, height: width * sx / sy * page.height / page.width };
}
