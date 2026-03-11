import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { GzipStream } from '../../src/gzip-stream.js';

function createPayload(size) {
  const payload = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    payload[index] = index % 251;
  }
  return payload;
}

async function withTempGzip(payload, callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rktool-gzip-'));
  const gzipPath = path.join(tempDir, 'payload.bin.gz');

  try {
    await fs.writeFile(gzipPath, gzipSync(payload));
    return await callback(gzipPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test('constructor resolves uncompressed size hint from gzip trailer', async () => {
  const payload = createPayload(12345);

  await withTempGzip(payload, async (gzipPath) => {
    const stream = new GzipStream(gzipPath);
    assert.equal(stream.uncompressedSize, payload.byteLength);
  });
});

test('open prefetches 4KB and read supports cache + sequential mode', async () => {
  const payload = createPayload(8192);

  await withTempGzip(payload, async (gzipPath) => {
    const stream = new GzipStream(gzipPath);
    const openResult = stream.open();
    assert.equal(openResult, undefined);

    try {
      const head = new Uint8Array(32);
      const headRead = stream.read(head, 0, head.byteLength, 0);
      assert.equal(headRead, 32);
      assert.deepEqual(head, payload.subarray(0, 32));

      const cachedRange = new Uint8Array(64);
      const cachedRead = stream.read(cachedRange, 0, cachedRange.byteLength, 1500);
      assert.equal(cachedRead, 64);
      assert.deepEqual(cachedRange, payload.subarray(1500, 1564));

      const cachedReadRewind = stream.read(cachedRange, 0, cachedRange.byteLength, 1100);
      assert.equal(cachedReadRewind, 64);
      assert.deepEqual(cachedRange, payload.subarray(1100, 1164));

      const crossBoundary = new Uint8Array(300);
      const crossRead = stream.read(crossBoundary, 0, crossBoundary.byteLength, 3900);
      assert.equal(crossRead, 300);
      assert.deepEqual(crossBoundary, payload.subarray(3900, 4200));

      const sequential = new Uint8Array(100);
      const sequentialRead = stream.read(sequential, 0, sequential.byteLength, 4200);
      assert.equal(sequentialRead, 100);
      assert.deepEqual(sequential, payload.subarray(4200, 4300));

      const stillCached = new Uint8Array(16);
      const stillCachedRead = stream.read(stillCached, 0, stillCached.byteLength, 64);
      assert.equal(stillCachedRead, 16);
      assert.deepEqual(stillCached, payload.subarray(64, 80));
    } finally {
      const closeResult = stream.close();
      assert.equal(closeResult, undefined);
    }
  });
});

test('read rejects non-sequential access beyond cached prefix', async () => {
  const payload = createPayload(7000);

  await withTempGzip(payload, async (gzipPath) => {
    const stream = new GzipStream(gzipPath);
    stream.open();

    try {
      const firstChunk = new Uint8Array(128);
      const firstRead = stream.read(firstChunk, 0, firstChunk.byteLength, 4096);
      assert.equal(firstRead, 128);
      assert.deepEqual(firstChunk, payload.subarray(4096, 4224));

      assert.throws(
        () => stream.read(new Uint8Array(16), 0, 16, 5000),
        /must be sequential/
      );
    } finally {
      stream.close();
    }
  });
});

test('short payload reads from cache and returns 0 at EOF', async () => {
  const payload = createPayload(1024);

  await withTempGzip(payload, async (gzipPath) => {
    const stream = new GzipStream(gzipPath);
    stream.open();

    try {
      const target = new Uint8Array(1500);
      const readLength = stream.read(target, 0, target.byteLength, 0);
      assert.equal(readLength, 1024);
      assert.deepEqual(target.subarray(0, 1024), payload);

      const eofRead = stream.read(target, 0, 64, 1024);
      assert.equal(eofRead, 0);

      const afterEofRead = stream.read(target, 0, 64, 4096);
      assert.equal(afterEofRead, 0);
    } finally {
      stream.close();
    }
  });
});
