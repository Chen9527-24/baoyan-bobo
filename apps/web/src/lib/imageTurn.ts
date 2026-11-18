export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 1280;
export const MAX_PREPARED_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 32_000_000;
export type AllowedImageType = 'image/jpeg' | 'image/png' | 'image/webp';
export interface ImageDescription { type: AllowedImageType; width: number; height: number }
export interface PreparedImage { image: Blob; width: number; height: number }

const fail = (message = '这张照片无法读取，请重选 JPG、PNG 或 WebP 静态照片。'): never => { throw new Error(message); };
const ascii = (data: Uint8Array, start: number, count: number) => String.fromCharCode(...data.subarray(start, start + count));
const le24 = (data: Uint8Array, offset: number) => data[offset]! | data[offset + 1]! << 8 | data[offset + 2]! << 16;

/** Inspect the actual container before allowing the browser to decode it. No filenames, URLs or file content are executed. */
export function inspectImageBytes(data: Uint8Array, declaredType?: string): ImageDescription {
  if (!data.length || data.length > MAX_IMAGE_BYTES) fail('请选择一张不超过 5 MB 的照片。');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let type: AllowedImageType;
  let width = 0; let height = 0;
  if (data.length >= 12 && data[0] === 0xff && data[1] === 0xd8) {
    type = 'image/jpeg';
    if (data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) fail();
    let offset = 2;
    while (offset < data.length - 2) {
      if (data[offset] !== 0xff) fail();
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++]!;
      if (marker === 0xda) break;
      if (marker === 0xd8 || marker === 0x00 || marker === 0xd9) fail();
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > data.length) fail();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > data.length) fail();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) fail();
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
      }
      offset += length;
    }
  } else if (data.length >= 45 && data.subarray(0, 8).every((byte, i) => byte === [137, 80, 78, 71, 13, 10, 26, 10][i])) {
    type = 'image/png';
    let offset = 8; let header = false; let pixels = false; let ended = false;
    while (offset + 12 <= data.length) {
      const length = view.getUint32(offset); const chunk = ascii(data, offset + 4, 4);
      if (offset + length + 12 > data.length || !/^[A-Za-z]{4}$/.test(chunk)) fail();
      if (chunk === 'acTL' || chunk === 'fcTL' || chunk === 'fdAT') fail('暂时只支持静态照片，请重选一张照片。');
      if (chunk === 'IHDR') {
        if (header || offset !== 8 || length !== 13) fail();
        width = view.getUint32(offset + 8); height = view.getUint32(offset + 12); header = true;
      } else if (!header) fail();
      if (chunk === 'IDAT') pixels = true;
      if (chunk === 'IEND') {
        if (length !== 0 || offset + 12 !== data.length) fail();
        ended = true; break;
      }
      offset += length + 12;
    }
    if (!header || !pixels || !ended) fail();
  } else if (data.length >= 26 && ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP') {
    type = 'image/webp';
    if (view.getUint32(4, true) + 8 !== data.length) fail();
    let offset = 12; let pixels = false;
    while (offset + 8 <= data.length) {
      const chunk = ascii(data, offset, 4); const length = view.getUint32(offset + 4, true); const start = offset + 8;
      if (start + length + (length % 2) > data.length) fail();
      if (chunk === 'ANIM' || chunk === 'ANMF') fail('暂时只支持静态照片，请重选一张照片。');
      if (chunk === 'VP8X') {
        if (length !== 10) fail();
        if ((data[start]! & 0x02) !== 0) fail('暂时只支持静态照片，请重选一张照片。');
        width = le24(data, start + 4) + 1; height = le24(data, start + 7) + 1;
      } else if (chunk === 'VP8 ') {
        if (length < 10 || data[start + 3] !== 0x9d || data[start + 4] !== 0x01 || data[start + 5] !== 0x2a) fail();
        if (!width) { width = view.getUint16(start + 6, true) & 0x3fff; height = view.getUint16(start + 8, true) & 0x3fff; }
        pixels = true;
      } else if (chunk === 'VP8L') {
        if (length < 5 || data[start] !== 0x2f) fail();
        const bits = view.getUint32(start + 1, true);
        if (!width) { width = (bits & 0x3fff) + 1; height = (bits >>> 14 & 0x3fff) + 1; }
        pixels = true;
      }
      offset = start + length + (length % 2);
    }
    if (!pixels || offset !== data.length) fail();
  } else return fail();
  if (declaredType && declaredType !== type) fail('照片格式与文件内容不一致，请重选或截图后再试。');
  if (!width || !height || width * height > MAX_SOURCE_PIXELS || width > 32_000 || height > 32_000) fail('照片尺寸过大或无法读取，请缩小后再试。');
  return { type, width, height };
}

export function fitImageSize(width: number, height: number): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) fail();
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function abortIfNeeded(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('已取消', 'AbortError'); }

export async function prepareImage(file: Blob, signal?: AbortSignal): Promise<PreparedImage> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) fail('请选择 JPG、PNG 或 WebP 照片，暂不支持其他格式。');
  if (!file.size || file.size > MAX_IMAGE_BYTES) fail('请选择一张不超过 5 MB 的照片。');
  abortIfNeeded(signal);
  inspectImageBytes(new Uint8Array(await file.arrayBuffer()), file.type);
  abortIfNeeded(signal);
  let source: CanvasImageSource; let width: number; let height: number; let dispose = () => {};
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    source = bitmap; width = bitmap.width; height = bitmap.height; dispose = () => bitmap.close();
  } else {
    const url = URL.createObjectURL(file); const img = new Image();
    try {
      await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('这张照片未能读取，请重选一张。')); img.src = url; });
    } catch (error) { URL.revokeObjectURL(url); throw error; }
    source = img; width = img.naturalWidth; height = img.naturalHeight; dispose = () => { img.src = ''; URL.revokeObjectURL(url); };
  }
  try {
    abortIfNeeded(signal);
    if (!width || !height || width * height > MAX_SOURCE_PIXELS) fail('照片尺寸过大，请缩小后再试。');
    const size = fitImageSize(width, height); const canvas = document.createElement('canvas');
    canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d') ?? fail('当前浏览器暂时无法整理照片，可换一个浏览器试试。');
    context.fillStyle = '#fff'; context.fillRect(0, 0, size.width, size.height); context.drawImage(source, 0, 0, size.width, size.height);
    const image = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('照片整理失败，请重选一张。')), 'image/jpeg', 0.86));
    canvas.width = 0; canvas.height = 0;
    abortIfNeeded(signal);
    if (image.size > MAX_PREPARED_IMAGE_BYTES) fail('整理后的照片仍然过大，请缩小或截图后再试。');
    const checked = inspectImageBytes(new Uint8Array(await image.arrayBuffer()), 'image/jpeg');
    if (image.type !== 'image/jpeg' || checked.width !== size.width || checked.height !== size.height || Math.max(checked.width, checked.height) > MAX_IMAGE_SIDE) fail();
    return { image, ...size };
  } finally { dispose(); }
}
