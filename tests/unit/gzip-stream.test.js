import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  GzipStream,
} from '../../src/gzip-stream.js';
import { XzStream } from '../../src/xz-stream.js';
import { NodeBlob } from '../../src/node-blob.js';

const XZ_PAYLOAD_4096_BASE64 = '/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4A//AP5dAAAAUlAKhPmbsoAhqWnWJ+A+BlpfBI1T1AS6OVcFCcFVJN6duHFZMWChn/lvSXPyyOqMuhqLKWkhgP4zg2avRm3snomKC4PwPA6Jjj/tX+eekNkc/zL0suA5UbLSFBW0xXG62wbjeZqfuzjBsACskwuqBhkDEggVW5vISPAyLv4toIfI8KTg0lHrjWdWkrJNhMXxhjHfamJbwnkt2fc8c7p0dAfYPKlWIiShZvhahF8wZ9L2S0kufyDr2/gQDpR4d8c/a++0zZXib/ZEbgbPC4Iay9t68FeNmP+QwD7mwRJBde4DnqjoegSV0b7AfmdyeuC6vVn/y92z0gXdygAAAAAAYM+XaK2iHMEAAZoCgCAAAENCfNCxxGf7AgAAAAAEWVo=';

function createPayload(size) {
  const payload = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    payload[index] = index % 251;
  }
  return payload;
}

function decodeBase64Bytes(base64Text) {
  return new Uint8Array(Buffer.from(base64Text, 'base64'));
}

function appendOpenWrtMetadata(gzipBytes, blockSizes) {
  const normalizedBlocks = Array.isArray(blockSizes) ? blockSizes : [];
  const totalMetadataSize = normalizedBlocks.reduce((sum, size) => sum + size, 0);
  const output = new Uint8Array(gzipBytes.byteLength + totalMetadataSize);
  output.set(gzipBytes, 0);

  let writeOffset = gzipBytes.byteLength;
  for (const blockSize of normalizedBlocks) {
    const metadataBlock = new Uint8Array(blockSize);
    metadataBlock.fill(0x5a, 0, Math.max(0, blockSize - 16));
    metadataBlock[blockSize - 16] = 0x46; // F
    metadataBlock[blockSize - 15] = 0x57; // W
    metadataBlock[blockSize - 14] = 0x78; // x
    metadataBlock[blockSize - 13] = 0x30; // 0
    metadataBlock[blockSize - 4] = (blockSize >>> 24) & 0xff;
    metadataBlock[blockSize - 3] = (blockSize >>> 16) & 0xff;
    metadataBlock[blockSize - 2] = (blockSize >>> 8) & 0xff;
    metadataBlock[blockSize - 1] = blockSize & 0xff;

    output.set(metadataBlock, writeOffset);
    writeOffset += blockSize;
  }

  return output;
}

async function withTempCompressedBytes(fileName, bytes, callback) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rktool-gzip-'));
  const sourcePath = path.join(tempDir, fileName);

  try {
    await fs.writeFile(sourcePath, bytes);
    const sourceBlob = new NodeBlob(sourcePath);
    try {
      return await callback(sourceBlob, sourcePath);
    } finally {
      sourceBlob.close();
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function withTempGzip(payload, callback) {
  return withTempCompressedBytes('payload.bin.gz', gzipSync(payload), callback);
}

async function withTempGzipBytes(gzipBytes, callback) {
  return withTempCompressedBytes('payload.bin.gz', gzipBytes, callback);
}

function readFully(stream, totalSize, chunkSize = 257) {
  const output = new Uint8Array(totalSize);
  let totalRead = 0;

  while (totalRead < output.byteLength) {
    const bytesRead = stream.read(
      output,
      totalRead,
      Math.min(chunkSize, output.byteLength - totalRead),
      totalRead
    );
    if (bytesRead === 0) {
      break;
    }
    totalRead += bytesRead;
  }

  return {
    output,
    totalRead,
  };
}

test('constructor resolves uncompressed size hint from gzip trailer', async () => {
  const payload = createPayload(12345);

  await withTempGzip(payload, async (gzipBlob) => {
    const stream = new GzipStream(gzipBlob);
    assert.equal(stream.uncompressedSize, payload.byteLength);
  });
});

test('constructor rejects path-string source in node runtime', async () => {
  const payload = createPayload(256);

  await withTempGzip(payload, async (_gzipBlob, gzipPath) => {
    assert.throws(() => new GzipStream(gzipPath), /Blob-like/);
  });
});

test('constructor throws when source is null', () => {
  assert.throws(
    () => new GzipStream(null),
    /Blob-like object with slice\(\)/
  );
});

test('constructor ignores OpenWrt metadata footer chain and corrects sizes', async () => {
  const payload = createPayload(12000);
  const rawGzip = gzipSync(payload);
  const metadataBlocks = [64, 96, 160];
  const metadataSize = metadataBlocks.reduce((sum, size) => sum + size, 0);
  const withMetadata = appendOpenWrtMetadata(rawGzip, metadataBlocks);

  await withTempGzipBytes(withMetadata, async (gzipBlob) => {
    const stream = new GzipStream(gzipBlob);

    assert.equal(stream.metadataSize, metadataSize);
    assert.equal(stream.compressedSize, rawGzip.byteLength);
    assert.equal(stream.uncompressedSize, payload.byteLength);

    stream.open();
    try {
      const output = new Uint8Array(payload.byteLength + 128);
      let totalRead = 0;
      while (totalRead < output.byteLength) {
        const bytesRead = stream.read(output, totalRead, 257, totalRead);
        if (bytesRead === 0) {
          break;
        }
        totalRead += bytesRead;
      }

      assert.equal(totalRead, payload.byteLength);
      assert.deepEqual(output.subarray(0, totalRead), payload);
    } finally {
      stream.close();
    }
  });
});

test('open prefetches 4KB and read supports cache + sequential mode', async () => {
  const payload = createPayload(8192);

  await withTempGzip(payload, async (gzipBlob) => {
    const stream = new GzipStream(gzipBlob);
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

  await withTempGzip(payload, async (gzipBlob) => {
    const stream = new GzipStream(gzipBlob);
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

  await withTempGzip(payload, async (gzipBlob) => {
    const stream = new GzipStream(gzipBlob);
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

test('XzStream supports built-in xz format with sync decoding', async () => {
  const payload = createPayload(4096);
  const xzBytes = decodeBase64Bytes(XZ_PAYLOAD_4096_BASE64);

  await withTempCompressedBytes('payload.bin.xz', xzBytes, async (xzBlob) => {
    const stream = new XzStream(xzBlob, {
      prefixCacheSize: 256,
    });

    assert.equal(stream.uncompressedSize, payload.byteLength);

    stream.open();
    try {
      const { output, totalRead } = readFully(stream, payload.byteLength, 233);
      assert.equal(totalRead, payload.byteLength);
      assert.deepEqual(output, payload);

      const eofRead = stream.read(new Uint8Array(16), 0, 16, payload.byteLength);
      assert.equal(eofRead, 0);
    } finally {
      stream.close();
    }
  });
});

test('XzStream ignores OpenWrt metadata footer chain and corrects sizes', async () => {
  const payload = createPayload(4096);
  const rawXz = decodeBase64Bytes(XZ_PAYLOAD_4096_BASE64);
  const metadataBlocks = [64, 96, 160];
  const metadataSize = metadataBlocks.reduce((sum, size) => sum + size, 0);
  const withMetadata = appendOpenWrtMetadata(rawXz, metadataBlocks);

  await withTempCompressedBytes('payload.bin.xz', withMetadata, async (xzBlob) => {
    const stream = new XzStream(xzBlob, {
      prefixCacheSize: 256,
    });

    assert.equal(stream.metadataSize, metadataSize);
    assert.equal(stream.compressedSize, rawXz.byteLength);
    assert.equal(stream.uncompressedSize, payload.byteLength);

    stream.open();
    try {
      const { output, totalRead } = readFully(stream, payload.byteLength, 233);
      assert.equal(totalRead, payload.byteLength);
      assert.deepEqual(output, payload);

      const eofRead = stream.read(new Uint8Array(16), 0, 16, payload.byteLength);
      assert.equal(eofRead, 0);
    } finally {
      stream.close();
    }
  });
});

