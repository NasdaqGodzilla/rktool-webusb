import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseRkfwBlob } from '../../src/rkfw-parser.js';
import { NodeBlob } from '../../src/node-blob.js';

const REAL_IMAGE_PATH = '/Volumes/data/blob/rk3568/r68s-update-0610.img';

function writeAscii(target, offset, text, fieldSize = text.length) {
  const safeFieldSize = Math.max(0, Number(fieldSize) || 0);
  for (let index = 0; index < safeFieldSize; index++) {
    target[offset + index] = 0;
  }

  const maxLength = Math.min(text.length, safeFieldSize);
  for (let index = 0; index < maxLength; index++) {
    target[offset + index] = text.charCodeAt(index) & 0xff;
  }
}

function createRkfwFixtureBlob() {
  const totalSize = 0x5000;
  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);

  const loaderOffset = 0x100;
  const loaderSize = 0x40;
  const imageOffset = 0x400;
  const imageSize = 0x3000;

  writeAscii(bytes, 0x00, 'RKFW', 4);
  view.setUint32(0x19, loaderOffset, true);
  view.setUint32(0x1d, loaderSize, true);
  view.setUint32(0x21, imageOffset, true);
  view.setUint32(0x25, imageSize, true);

  writeAscii(bytes, imageOffset + 0x00, 'RKAF', 4);
  writeAscii(bytes, imageOffset + 0x08, 'RK3588', 0x22);
  writeAscii(bytes, imageOffset + 0x48, 'Rockchip', 0x38);
  view.setUint32(imageOffset + 0x88, 3, true);

  const firstPartOffset = imageOffset + 0x8c;
  const parameterPos = 0x900;
  const parameterPartitionSize = 0x80;
  const parameterRealSize = 0x40;
  writeAscii(bytes, firstPartOffset + 0x00, 'parameter', 32);
  writeAscii(bytes, firstPartOffset + 0x20, 'parameter.txt', 60);
  view.setUint32(firstPartOffset + 0x60, parameterPos, true);
  view.setUint32(firstPartOffset + 0x64, 0x2000, true);
  view.setUint32(firstPartOffset + 0x6c, parameterPartitionSize, true);

  const parameterAbsOffset = imageOffset + parameterPos;
  writeAscii(bytes, parameterAbsOffset, 'PARM', 4);
  view.setUint32(parameterAbsOffset + 4, parameterRealSize, true);

  const secondPartOffset = firstPartOffset + 0x70;
  writeAscii(bytes, secondPartOffset + 0x00, 'zero-size', 32);
  writeAscii(bytes, secondPartOffset + 0x20, 'zero.bin', 60);
  view.setUint32(secondPartOffset + 0x60, 0x980, true);
  view.setUint32(secondPartOffset + 0x64, 0x2100, true);
  view.setUint32(secondPartOffset + 0x6c, 0x00, true);

  const thirdPartOffset = secondPartOffset + 0x70;
  writeAscii(bytes, thirdPartOffset + 0x00, 'boot', 32);
  writeAscii(bytes, thirdPartOffset + 0x20, 'boot.img', 60);
  view.setUint32(thirdPartOffset + 0x60, 0xA00, true);
  view.setUint32(thirdPartOffset + 0x64, 0x2200, true);
  view.setUint32(thirdPartOffset + 0x6c, 0x100, true);

  return new Blob([bytes]);
}

test('parseRkfwBlob parses loader and partitions from blob', async () => {
  const blob = createRkfwFixtureBlob();
  const parsed = await parseRkfwBlob(blob);

  assert.equal(parsed.model, 'RK3588');
  assert.equal(parsed.manufacturer, 'Rockchip');
  assert.deepEqual(parsed.loader, {
    name: 'MiniLoaderAll.bin',
    offset: 0x100,
    size: 0x40,
    flashSector: null,
  });

  assert.equal(parsed.parts.length, 2);
  assert.deepEqual(parsed.parts[0], {
    name: 'parameter',
    fileName: 'parameter.txt',
    offset: 0x400 + 0x900 + 8,
    size: 0x40,
    flashSector: 0x2000,
  });
  assert.deepEqual(parsed.parts[1], {
    name: 'boot',
    fileName: 'boot.img',
    offset: 0x400 + 0xA00,
    size: 0x100,
    flashSector: 0x2200,
  });
});

test('parseRkfwBlob throws when RKFW magic is invalid', async () => {
  const bytes = new Uint8Array(0x1000);
  writeAscii(bytes, 0x00, 'NOPE', 4);
  const blob = new Blob([bytes]);

  await assert.rejects(
    () => parseRkfwBlob(blob),
    /Not an RKFW blob/
  );
});

test(
  'parseRkfwBlob parses /Volumes/data/blob/rk3568/r68s-update-0610.img and prints structure',
  { skip: !fs.existsSync(REAL_IMAGE_PATH) },
  async () => {
    const blob = new NodeBlob(REAL_IMAGE_PATH);
    try {
      const parsed = await parseRkfwBlob(blob);

      console.log(JSON.stringify(parsed, null, 2));

      assert.equal(parsed.loader.name, 'MiniLoaderAll.bin');
      assert.equal(typeof parsed.loader.offset, 'number');
      assert.equal(typeof parsed.loader.size, 'number');
      assert.ok(parsed.loader.size > 0);
      assert.equal(parsed.loader.flashSector, null);

      assert.ok(Array.isArray(parsed.parts));
      assert.ok(parsed.parts.length > 0);
      for (const part of parsed.parts) {
        assert.equal(typeof part.name, 'string');
        assert.ok(part.name.length > 0);
        assert.ok(part.fileName === null || typeof part.fileName === 'string');
        assert.equal(typeof part.offset, 'number');
        assert.equal(typeof part.size, 'number');
        assert.ok(part.size > 0);
        assert.ok(part.flashSector === null || typeof part.flashSector === 'number');
      }
    } finally {
      blob.close();
    }
  }
);
