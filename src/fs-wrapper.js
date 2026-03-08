const DEFAULT_MOUNT_ROOT = '/tmp/mounts';

function ensureDir(FS, dirPath) {
  const dirExists = () => {
    try {
      if (typeof FS.analyzePath === 'function') {
        return FS.analyzePath(dirPath).exists;
      }
      if (typeof FS.stat === 'function' && typeof FS.isDir === 'function') {
        const stat = FS.stat(dirPath);
        return FS.isDir(stat.mode);
      }
    } catch (_error) {
      return false;
    }
    return false;
  };

  if (dirExists()) {
    return;
  }

  try {
    FS.mkdir(dirPath);
  } catch (error) {
    if (!dirExists() && !String(error && error.message).includes('File exists')) {
      throw error;
    }
  }
}

function sanitizeSegment(name) {
  return String(name || 'input')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'input';
}

function toMountName(name) {
  return `${sanitizeSegment(name)}-${Date.now()}`;
}

function isNodeRuntime(runtime) {
  return runtime === 'node';
}

function isBrowserRuntime(runtime) {
  return runtime === 'browser';
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) {
    return data;
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return null;
}

async function readSourceBytes(source) {
  const directBytes = toUint8Array(source);
  if (directBytes) {
    return directBytes;
  }

  if (source && typeof source.arrayBuffer === 'function') {
    const buffer = await source.arrayBuffer();
    return new Uint8Array(buffer);
  }

  if (typeof source === 'string') {
    const fsModule = await import('node:fs/promises');
    const buffer = await fsModule.readFile(source);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  throw new Error('Unable to read file source bytes for browser runtime');
}

export function ensureRuntimeDirs(FS) {
  ensureDir(FS, '/tmp');
  ensureDir(FS, '/tmp/log');
  ensureDir(FS, DEFAULT_MOUNT_ROOT);
}

export function createFsWrapper(moduleInstance, options = {}) {
  if (!moduleInstance || !moduleInstance.FS) {
    throw new Error('moduleInstance.FS is required');
  }

  const runtime = options.runtime || 'node';
  const mountRoot = options.mountRoot || DEFAULT_MOUNT_ROOT;
  const FS = moduleInstance.FS;
  const WORKERFS = moduleInstance.WORKERFS || FS.filesystems?.WORKERFS;
  const NODEFS = moduleInstance.NODEFS || FS.filesystems?.NODEFS;

  ensureRuntimeDirs(FS);
  ensureDir(FS, mountRoot);

  async function mountFile(name, source) {
    if (!source) {
      throw new Error('source is required');
    }

    const mountName = toMountName(name);
    const mountPoint = `${mountRoot}/${mountName}`;
    ensureDir(FS, mountPoint);

    if (isBrowserRuntime(runtime)) {
      const fileObject = source;
      const fileName = fileObject.name || name || 'input.bin';

      if (WORKERFS) {
        try {
          FS.mount(WORKERFS, { files: [fileObject] }, mountPoint);
          return `${mountPoint}/${fileName}`;
        } catch (_error) {
        }
      }

      if (typeof FS.writeFile !== 'function') {
        throw new Error('FS.writeFile is required for browser file fallback');
      }

      const bytes = await readSourceBytes(source);
      const virtualPath = `${mountPoint}/${fileName}`;
      FS.writeFile(virtualPath, bytes);
      return virtualPath;
    }

    if (isNodeRuntime(runtime)) {
      const pathModule = await import('node:path');
      const absolutePath = pathModule.resolve(String(source));
      const parentDir = pathModule.dirname(absolutePath);
      const baseName = pathModule.basename(absolutePath);

      if (!NODEFS) {
        return absolutePath;
      }

      FS.mount(NODEFS, { root: parentDir }, mountPoint);
      return `${mountPoint}/${baseName}`;
    }

    throw new Error(`Unsupported runtime: ${runtime}`);
  }

  async function mountDirectory(name, source) {
    if (!isNodeRuntime(runtime)) {
      throw new Error('mountDirectory is only supported in Node.js runtime');
    }

    if (!NODEFS) {
      return String(source);
    }

    const pathModule = await import('node:path');
    const absolutePath = pathModule.resolve(String(source));
    const mountPoint = `${mountRoot}/${toMountName(name || 'dir')}`;
    ensureDir(FS, mountPoint);
    FS.mount(NODEFS, { root: absolutePath }, mountPoint);
    return mountPoint;
  }

  function unmount(mountPoint) {
    try {
      FS.unmount(mountPoint);
    } catch (error) {
      if (!String(error && error.message).includes('not mounted')) {
        throw error;
      }
    }
  }

  return {
    mountFile,
    mountDirectory,
    unmount,
  };
}
