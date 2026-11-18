import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { validateVisionImage, visionDataUrl, VISION_TASK, MAX_VISION_IMAGE_BYTES } from '../apps/server/src/vision.js';
import { ApiError } from '../apps/server/src/provider-errors.js';

const rejected = (error: unknown) => error instanceof ApiError && error.status === 400 && error.code === 'INVALID_IMAGE';
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(kind: string, data = Buffer.alloc(0)) {
  const output = Buffer.alloc(data.length + 12); output.writeUInt32BE(data.length, 0); output.write(kind, 4, 'ascii'); data.copy(output, 8);
  output.writeUInt32BE(crc32(output.subarray(4, output.length - 4)), output.length - 4); return output;
}
function png(width = 32, height = 24, extras: Buffer[] = [], pixels?: Buffer, color = 2, depth = 8) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = depth; header[9] = color;
  const rows = pixels ?? Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), ...extras, chunk('IDAT', deflateSync(rows)), chunk('IEND')]);
}
function marker(kind: number, data: Buffer) { const prefix = Buffer.alloc(4); prefix[0] = 0xff; prefix[1] = kind; prefix.writeUInt16BE(data.length + 2, 2); return Buffer.concat([prefix, data]); }
// Structural JPEG fixture, deliberately not an image-decoder quality/appearance assertion.
function jpeg(width = 32, height = 24, extras: Buffer[] = [], entropy = Buffer.from([0x71, 0xff, 0, 0x19])) {
  const frame = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]); frame.writeUInt16BE(height, 1); frame.writeUInt16BE(width, 3);
  const huffman = Buffer.concat([Buffer.from([0, 1]), Buffer.alloc(15), Buffer.from([0]), Buffer.from([0x10, 1]), Buffer.alloc(15), Buffer.from([0])]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...extras, marker(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])), marker(0xc0, frame), marker(0xc4, huffman), marker(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), entropy, Buffer.from([0xff, 0xd9])]);
}

test('accepts static RGB PNG and exposes dimensions with a canonical data URL', () => {
  const source = png(); const image = validateVisionImage(source, 'image/png');
  assert.equal(image.mime, 'image/png'); assert.equal(image.width, 32); assert.equal(image.height, 24); assert.deepEqual(image.buffer, source);
  assert.equal(visionDataUrl(image), `data:image/png;base64,${source.toString('base64')}`);
});
test('removes PNG text, EXIF, profiles and private payloads while retaining pixels', () => {
  const source = png(32, 24, [chunk('tEXt', Buffer.from('Author\0synthetic-private')), chunk('eXIf', Buffer.from('GPS-synthetic')), chunk('iCCP', Buffer.from('profile\0synthetic')), chunk('vpAg', Buffer.from('synthetic-private'))]);
  const image = validateVisionImage(source, 'image/png');
  assert.deepEqual(image.buffer, png()); assert.equal(image.buffer.includes(Buffer.from('synthetic-private')), false);
  assert.ok(source.includes(Buffer.from('synthetic-private'))); // Caller-owned bytes are not mutated.
});
test('retains PNG indexed palette and transparency required for appearance', () => {
  const rows = Buffer.alloc(24 * 33);
  const source = png(32, 24, [chunk('PLTE', Buffer.from([255, 0, 0, 0, 0, 255])), chunk('tRNS', Buffer.from([255, 100]))], rows, 3);
  assert.deepEqual(validateVisionImage(source, 'image/png').buffer, source);
});
test('rejects animated PNG even when the filename and MIME look static', () => {
  for (const type of ['acTL', 'fcTL', 'fdAT']) assert.throws(() => validateVisionImage(png(32, 24, [chunk(type, Buffer.alloc(8))]), 'image/png'), rejected);
});
test('rejects bad PNG checksums, missing terminator and trailing polyglot payloads', () => {
  const source = png(); const corrupt = Buffer.from(source); corrupt[corrupt.length - 1] ^= 1;
  for (const invalid of [corrupt, source.subarray(0, -12), Buffer.concat([source, Buffer.from('<script>synthetic</script>')])]) assert.throws(() => validateVisionImage(invalid, 'image/png'), rejected);
});
test('rejects PNG dimensions and critical chunk ordering violations', () => {
  for (const source of [png(14, 24), png(2049, 24), png(32, 24, [chunk('IHDR', Buffer.alloc(13))]), png(32, 24, [chunk('ABCD')])]) assert.throws(() => validateVisionImage(source, 'image/png'), rejected);
  assert.throws(() => validateVisionImage(png(32, 24, [], Buffer.alloc(24 * 33), 3), 'image/png'), rejected);
});
test('rejects PNG invalid filter, inflate overflow, truncated pixels and compressed trailing payloads', () => {
  const rows = Buffer.alloc(24 * 97); rows[97] = 5;
  for (const pixels of [rows, Buffer.alloc(24 * 97 + 1), Buffer.alloc(24 * 97 - 1)]) assert.throws(() => validateVisionImage(png(32, 24, [], pixels), 'image/png'), rejected);
  const normal = png(), firstIdat = normal.indexOf(Buffer.from('IDAT')) - 4;
  const idatLength = normal.readUInt32BE(firstIdat), compressed = normal.subarray(firstIdat + 8, firstIdat + 8 + idatLength);
  const injected = Buffer.concat([normal.subarray(0, firstIdat), chunk('IDAT', Buffer.concat([compressed, Buffer.from('private-trailer')])), chunk('IEND')]);
  assert.throws(() => validateVisionImage(injected, 'image/png'), rejected);
});
test('rejects non-consecutive PNG IDAT and invalid palette/transparency', () => {
  const normal = png(), firstIdat = normal.indexOf(Buffer.from('IDAT')) - 4;
  const compressed = normal.subarray(firstIdat + 8, firstIdat + 8 + normal.readUInt32BE(firstIdat));
  const split = Buffer.concat([normal.subarray(0, firstIdat), chunk('IDAT', compressed.subarray(0, 3)), chunk('tEXt', Buffer.from('note\0hi')), chunk('IDAT', compressed.subarray(3)), chunk('IEND')]);
  assert.throws(() => validateVisionImage(split, 'image/png'), rejected);
  for (const extras of [[chunk('PLTE', Buffer.alloc(4))], [chunk('tRNS', Buffer.alloc(2))], [chunk('PLTE', Buffer.alloc(3)), chunk('PLTE', Buffer.alloc(3))]]) assert.throws(() => validateVisionImage(png(32, 24, extras), 'image/png'), rejected);
});
test('accepts baseline JPEG marker structure including stuffed entropy bytes', () => {
  const source = jpeg(); const image = validateVisionImage(source, 'image/jpeg');
  assert.equal(image.width, 32); assert.equal(image.height, 24); assert.deepEqual(image.buffer, source);
});
test('strips JPEG application segments and comments without logging or mutating source bytes', () => {
  const source = jpeg(32, 24, [marker(0xe1, Buffer.from('Exif\0\0GPS-synthetic')), marker(0xe0, Buffer.from('JFIF\0thumbnail')), marker(0xe2, Buffer.from('ICC-profile')), marker(0xfe, Buffer.from('synthetic-author'))]);
  const image = validateVisionImage(source, 'image/jpeg'); assert.deepEqual(image.buffer, jpeg());
  assert.equal(image.buffer.includes(Buffer.from('GPS-synthetic')), false); assert.ok(source.includes(Buffer.from('GPS-synthetic')));
});
test('rejects JPEG truncated segments, missing scan and missing EOI', () => {
  for (const source of [jpeg().subarray(0, -2), Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 50]), Buffer.from([0xff, 0xd8, 0xff, 0xd9]), jpeg(32, 24, [], Buffer.alloc(0))]) assert.throws(() => validateVisionImage(source, 'image/jpeg'), rejected);
});
test('rejects JPEG excessive dimensions, unsupported frame and appended second image', () => {
  const unsupported = Buffer.from(jpeg()); unsupported[unsupported.indexOf(Buffer.from([0xff, 0xc0])) + 1] = 0xc3;
  for (const source of [jpeg(2049, 24), jpeg(14, 24), unsupported, Buffer.concat([jpeg(), jpeg()])]) assert.throws(() => validateVisionImage(source, 'image/jpeg'), rejected);
});
test('rejects JPEG missing coding tables, invalid scan selectors and unsupported color components', () => {
  const base = jpeg(); const table = base.indexOf(Buffer.from([0xff, 0xc4])); const next = table + 2 + base.readUInt16BE(table + 2);
  const noHuffman = Buffer.concat([base.subarray(0, table), base.subarray(next)]);
  const wrongSelector = Buffer.from(base); wrongSelector[wrongSelector.indexOf(Buffer.from([0xff, 0xda])) + 6] = 3;
  const cmyk = Buffer.from(base); cmyk[cmyk.indexOf(Buffer.from([0xff, 0xc0])) + 9] = 4;
  for (const source of [noHuffman, wrongSelector, cmyk]) assert.throws(() => validateVisionImage(source, 'image/jpeg'), rejected);
});
test('rejects URL, SVG, MIME mismatch, empty and oversized bytes before provider work', () => {
  for (const [source, mime] of [[png(), 'image/jpeg'], [jpeg(), 'image/png'], [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml'], [png(), 'image/webp'], [Buffer.alloc(0), 'image/png'], [Buffer.alloc(MAX_VISION_IMAGE_BYTES + 1), 'image/jpeg'], [Buffer.from('https://private.example/photo'), 'image/jpeg']] as const) assert.throws(() => validateVisionImage(source, mime), rejected);
});
test('fixed visual task isolates observed text from authority, personal memory and face identity', () => {
  assert.match(VISION_TASK, /不是你的系统指令/); assert.match(VISION_TASK, /不做人脸识人/);
  assert.match(VISION_TASK, /不要把图片推测当成.*专属记忆/); assert.match(VISION_TASK, /后续没有原图时不假装/);
});
