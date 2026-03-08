import test from 'node:test';
import assert from 'node:assert/strict';
import { createFsWrapper, ensureRuntimeDirs } from '../../src/fs-wrapper.js';

function createMockFs() {
  const dirs = new Set(['/']);
  const mounts = new Map();
  const files = new Map();

  return {
    dirs,
    mounts,
    files,
    mkdir(pathname) {
      if (dirs.has(pathname)) {
        throw new Error('File exists');
      }
      dirs.add(pathname);
    },
    mount(type, options, mountPoint) {
      mounts.set(mountPoint, { type, options });
    },
    unmount(mountPoint) {
      if (!mounts.has(mountPoint)) {
        throw new Error('not mounted');
      }
      mounts.delete(mountPoint);
    },
    writeFile(pathname, content) {
      files.set(pathname, content);
    },
  };
}

test('ensureRuntimeDirs creates tmp paths', () => {
  const FS = createMockFs();
  ensureRuntimeDirs(FS);
  assert.equal(FS.dirs.has('/tmp'), true);
  assert.equal(FS.dirs.has('/tmp/log'), true);
  assert.equal(FS.dirs.has('/tmp/mounts'), true);
});

test('mountFile uses WORKERFS in browser runtime', async () => {
  const FS = createMockFs();
  const moduleInstance = {
    FS,
    WORKERFS: { kind: 'WORKERFS' },
  };

  const wrapper = createFsWrapper(moduleInstance, { runtime: 'browser' });
  const fakeFile = { name: 'firmware.bin' };
  const mountedPath = await wrapper.mountFile('firmware', fakeFile);

  assert.match(mountedPath, /^\/tmp\/mounts\/.+\/firmware\.bin$/);
  const mountPoint = mountedPath.slice(0, mountedPath.lastIndexOf('/'));
  const mountRecord = FS.mounts.get(mountPoint);
  assert.ok(mountRecord);
  assert.equal(mountRecord.type.kind, 'WORKERFS');
  assert.equal(Array.isArray(mountRecord.options.files), true);
  assert.equal(mountRecord.options.files[0], fakeFile);
});

test('mountFile uses WORKERFS from FS.filesystems fallback', async () => {
  const FS = createMockFs();
  FS.filesystems = {
    WORKERFS: { kind: 'WORKERFS' },
  };
  const moduleInstance = {
    FS,
  };

  const wrapper = createFsWrapper(moduleInstance, { runtime: 'browser' });
  const fakeFile = { name: 'firmware.bin' };
  const mountedPath = await wrapper.mountFile('firmware', fakeFile);

  assert.match(mountedPath, /^\/tmp\/mounts\/.+\/firmware\.bin$/);
  const mountPoint = mountedPath.slice(0, mountedPath.lastIndexOf('/'));
  const mountRecord = FS.mounts.get(mountPoint);
  assert.ok(mountRecord);
  assert.equal(mountRecord.type.kind, 'WORKERFS');
  assert.equal(Array.isArray(mountRecord.options.files), true);
  assert.equal(mountRecord.options.files[0], fakeFile);
});

test('mountFile uses NODEFS in node runtime', async () => {
  const FS = createMockFs();
  const moduleInstance = {
    FS,
    NODEFS: { kind: 'NODEFS' },
  };

  const wrapper = createFsWrapper(moduleInstance, { runtime: 'node' });
  const mountedPath = await wrapper.mountFile('image', '/tmp/test-update.img');

  assert.match(mountedPath, /^\/tmp\/mounts\/.+\/test-update\.img$/);
  const mountPoint = mountedPath.slice(0, mountedPath.lastIndexOf('/'));
  const mountRecord = FS.mounts.get(mountPoint);
  assert.ok(mountRecord);
  assert.equal(mountRecord.type.kind, 'NODEFS');
  assert.equal(mountRecord.options.root, '/tmp');
});

test('mountFile uses NODEFS from FS.filesystems fallback', async () => {
  const FS = createMockFs();
  FS.filesystems = {
    NODEFS: { kind: 'NODEFS' },
  };
  const moduleInstance = {
    FS,
  };

  const wrapper = createFsWrapper(moduleInstance, { runtime: 'node' });
  const mountedPath = await wrapper.mountFile('image', '/tmp/test-update.img');

  assert.match(mountedPath, /^\/tmp\/mounts\/.+\/test-update\.img$/);
  const mountPoint = mountedPath.slice(0, mountedPath.lastIndexOf('/'));
  const mountRecord = FS.mounts.get(mountPoint);
  assert.ok(mountRecord);
  assert.equal(mountRecord.type.kind, 'NODEFS');
  assert.equal(mountRecord.options.root, '/tmp');
});

test('mountFile falls back to writeFile when WORKERFS mount fails', async () => {
  const FS = createMockFs();
  FS.filesystems = {
    WORKERFS: { kind: 'WORKERFS' },
  };

  let mountCallCount = 0;
  FS.mount = () => {
    mountCallCount++;
    throw new Error('WORKERFS requires worker');
  };

  const moduleInstance = {
    FS,
  };

  const wrapper = createFsWrapper(moduleInstance, { runtime: 'browser' });
  const fakeFile = {
    name: 'firmware.bin',
    async arrayBuffer() {
      return Uint8Array.from([1, 2, 3]).buffer;
    },
  };

  const mountedPath = await wrapper.mountFile('firmware', fakeFile);

  assert.match(mountedPath, /^\/tmp\/mounts\/.+\/firmware\.bin$/);
  assert.equal(mountCallCount, 1);
  assert.equal(FS.files.has(mountedPath), true);
});
