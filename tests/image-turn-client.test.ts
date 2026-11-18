import test from 'node:test';
import assert from 'node:assert/strict';
import { fitImageSize, inspectImageBytes, MAX_IMAGE_BYTES, prepareImage } from '../apps/web/src/lib/imageTurn.ts';

function jpeg(width = 2, height = 1, metadata = false) {
  return Uint8Array.from([0xff, 0xd8, ...(metadata ? [0xff, 0xe1, 0, 8, 69, 120, 105, 102, 0, 0] : []),
    0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0,
    0xff, 0xda, 0, 12, 3, 1, 0, 2, 17, 3, 17, 0, 63, 0, 0, 0xff, 0xd9]);
}
const png = () => Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
function webp(animation = false) {
  const chunks = [...(animation ? [86, 80, 56, 88, 10, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0] : []), 86, 80, 56, 76, 6, 0, 0, 0, 0x2f, 0, 0, 0, 0, 0];
  const length = chunks.length + 4;
  return Uint8Array.from([82, 73, 70, 70, length & 255, length >> 8 & 255, 0, 0, 87, 69, 66, 80, ...chunks]);
}

test('actual byte signatures accept three static image containers and reject MIME spoofing or active documents', () => {
  assert.deepEqual(inspectImageBytes(jpeg(), 'image/jpeg'), { type: 'image/jpeg', width: 2, height: 1 });
  assert.deepEqual(inspectImageBytes(png(), 'image/png'), { type: 'image/png', width: 1, height: 1 });
  assert.deepEqual(inspectImageBytes(webp(), 'image/webp'), { type: 'image/webp', width: 1, height: 1 });
  assert.throws(() => inspectImageBytes(png(), 'image/jpeg'), /不一致/);
  for (const source of ['<svg onload="alert(1)"></svg>', '<html>photo.jpg</html>', 'https://example.test/photo.jpg', 'GIF89a']) assert.throws(() => inspectImageBytes(new TextEncoder().encode(source), 'image/png'), /无法读取/);
});

test('animated PNG and WebP are rejected even when the declared MIME is allowed', () => {
  const raw = png(); const animated = new Uint8Array(raw.length + 20);
  animated.set(raw.subarray(0, 33)); animated.set([0, 0, 0, 8, 97, 99, 84, 76, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0], 33); animated.set(raw.subarray(33), 53);
  assert.throws(() => inspectImageBytes(animated, 'image/png'), /静态/);
  assert.throws(() => inspectImageBytes(webp(true), 'image/webp'), /静态/);
});

test('truncated containers, appended payloads, empty files and oversized decode surfaces fail before browser decode', () => {
  assert.throws(() => inspectImageBytes(jpeg().subarray(0, 15)), /无法读取/);
  assert.throws(() => inspectImageBytes(png().subarray(0, 60)), /无法读取/);
  assert.throws(() => inspectImageBytes(Uint8Array.from([...png(), 0])), /无法读取/);
  assert.throws(() => inspectImageBytes(Uint8Array.from([...webp(), 0])), /无法读取/);
  assert.throws(() => inspectImageBytes(new Uint8Array(0)), /5 MB/);
  assert.throws(() => inspectImageBytes(new Uint8Array(MAX_IMAGE_BYTES + 1)), /5 MB/);
  assert.throws(() => inspectImageBytes(jpeg(32_000, 32_000)), /尺寸过大/);
});

test('photo sizing preserves aspect ratio without upscaling', () => {
  assert.deepEqual(fitImageSize(4096, 3072), { width: 1280, height: 960 });
  assert.deepEqual(fitImageSize(768, 2048), { width: 480, height: 1280 });
  assert.deepEqual(fitImageSize(500, 400), { width: 500, height: 400 });
  for (const value of [0, -1, Infinity, NaN]) assert.throws(() => fitImageSize(value, 100));
});

async function mockImageBrowser(run: (state: { calls: string[]; canvas: { width: number; height: number }; output: (blob: Blob) => void }) => Promise<void>) {
  const originalBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const calls: string[] = []; let output: Blob | undefined;
  const canvas = { width: 0, height: 0, getContext: () => ({ set fillStyle(_value: string) {}, fillRect() { calls.push('white-background'); }, drawImage() { calls.push('draw-decoded-pixels'); } }), toBlob(callback: (blob: Blob) => void, type: string, quality: number) { calls.push(`encode-${type}-${quality}`); callback(output ?? new Blob([jpeg(canvas.width, canvas.height)], { type: 'image/jpeg' })); } };
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => { calls.push('decode-local'); return { width: 4096, height: 3072, close() { calls.push('dispose-decoder'); } }; } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement(tag: string) { assert.equal(tag, 'canvas'); return canvas; } } });
  try { await run({ calls, canvas, output: blob => { output = blob; } }); }
  finally {
    if (originalBitmap) Object.defineProperty(globalThis, 'createImageBitmap', originalBitmap); else Reflect.deleteProperty(globalThis, 'createImageBitmap');
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument); else Reflect.deleteProperty(globalThis, 'document');
  }
}

test('browser preparation draws fresh pixels, encodes a smaller JPEG and never returns original EXIF bytes', async () => {
  await mockImageBrowser(async ({ calls, canvas }) => {
    const original = new Blob([jpeg(4096, 3072, true)], { type: 'image/jpeg' });
    const result = await prepareImage(original);
    assert.equal(result.image.type, 'image/jpeg'); assert.equal(result.width, 1280); assert.equal(result.height, 960);
    assert.equal(Buffer.from(await result.image.arrayBuffer()).includes(Buffer.from('Exif')), false);
    assert.notEqual(result.image, original); assert.deepEqual(calls, ['decode-local', 'white-background', 'draw-decoded-pixels', 'encode-image/jpeg-0.86', 'dispose-decoder']);
    assert.deepEqual({ width: canvas.width, height: canvas.height }, { width: 0, height: 0 });
  });
});

test('cancelled or unsupported preparations cannot decode or return an image', async () => {
  await mockImageBrowser(async ({ calls }) => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(prepareImage(new Blob([jpeg()], { type: 'image/jpeg' }), controller.signal), { name: 'AbortError' });
    await assert.rejects(prepareImage(new Blob(['<svg/>'], { type: 'image/svg+xml' })), /暂不支持/);
    await assert.rejects(prepareImage(new Blob([png()], { type: 'image/jpeg' })), /不一致/);
    assert.deepEqual(calls, []);
  });
});

test('encoder output must retain the new dimensions and allowed format', async () => {
  await mockImageBrowser(async ({ calls, output }) => {
    output(new Blob([jpeg(2, 1)], { type: 'image/jpeg' }));
    await assert.rejects(prepareImage(new Blob([jpeg(4096, 3072)], { type: 'image/jpeg' })), /无法读取/);
    assert.equal(calls.at(-1), 'dispose-decoder');
  });
});
