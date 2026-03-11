import { GzipStream } from './gzip-stream.js';

var ENVIRONMENT_IS_NODE = globalThis.process?.versions?.node && globalThis.process?.type != "renderer";

if (ENVIRONMENT_IS_NODE) {
  // When building an ES module `require` is not normally available.
  // We need to use `createRequire()` to construct the require()` function.
  const {createRequire} = await import("node:module");
  /** @suppress{duplicate} */ var require = createRequire(import.meta.url);

  var fs = require("node:fs");
  var assert = function (condition, text) {
    if (!condition) {
      // This build was created without ASSERTIONS defined.  `assert()` should not
      // ever be called in this configuration but in case there are callers in
      // the wild leave this simple abort() implementation here for now.
      abort(text);
    }
  }
}

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

function resolveBrowserMount(source, fallbackName) {
  if (!source || typeof source !== 'object') {
    throw new Error('Browser runtime requires a File/Blob-like source object');
  }

  const preferredName = typeof source.name === 'string' && source.name.trim()
    ? source.name
    : String(fallbackName || 'input.bin');

  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    return {
      mountOptions: {
        blobs: [{
          name: preferredName,
          data: source,
        }],
      },
      virtualName: preferredName,
    };
  }

  return {
    mountOptions: {
      files: [source],
    },
    virtualName: preferredName,
  };
}

function stripGzipExtension(fileName) {
  const normalized = String(fileName || 'input.bin.gz').trim() || 'input.bin.gz';
  const stripped = normalized.replace(/\.gz$/i, '');
  return stripped || 'input.bin';
}

function resolveBrowserGunzipMount(source, fallbackName) {
  if (!source || typeof source !== 'object' || typeof source.slice !== 'function') {
    throw new Error('Browser runtime gunzip requires a File/Blob-like source object with slice()');
  }

  const preferredName = typeof source.name === 'string' && source.name.trim()
    ? source.name
    : String(fallbackName || 'input.bin.gz');
  const virtualName = stripGzipExtension(preferredName);

  return {
    mountOptions: {
      files: [{
        name: virtualName,
        data: source,
        mtime: source.lastModifiedDate,
      }],
    },
    virtualName,
  };
}

function resolveGunzipSource(runtime, source) {
  if (isNodeRuntime(runtime)) {
    if (!source || typeof source.path !== 'string') {
      throw new Error('Node.js runtime gunzip source requires a local file path');
    }

    const sizeProbe = new GzipStream(source.path);

    return {
      kind: 'path',
      path: source.path,
      estimatedSize: sizeProbe.uncompressedSize,
    };
  }

  const blobSource = source?.data ?? source;
  if (!blobSource || typeof blobSource.slice !== 'function') {
    throw new Error('Browser runtime gunzip source requires a File/Blob-like object');
  }

   const sizeProbe = new GzipStream(blobSource);

  return {
    kind: 'blob',
    data: blobSource,
    estimatedSize: sizeProbe.uncompressedSize,
  };
}

export function ensureRuntimeDirs(FS) {
  ensureDir(FS, '/tmp');
  ensureDir(FS, '/tmp/log');
  ensureDir(FS, DEFAULT_MOUNT_ROOT);
}

export function workerFsForNode(moduleInstance) {
  const FS = moduleInstance.FS;
  const WORKERFS = moduleInstance.WORKERFS || FS.filesystems?.WORKERFS;
  if (!WORKERFS) {
    throw new Error('WORKERFS is required for browser file mapping');
  }

  const NODEWORKERFS = {
    ...WORKERFS,
    mount(mount) {
      //assert(ENVIRONMENT_IS_WORKER);
      //WORKERFS.reader ??= new FileReaderSync;
      var root = WORKERFS.createNode(null, "/", WORKERFS.DIR_MODE, 0);
      // We also accept FileList here
      for (var source of (mount.opts["files"] || [])) {
        NODEWORKERFS.createNode(root, source.name, WORKERFS.FILE_MODE, 0, source.path);
      }
      return root;
    },
    createNode(parent, name, mode, dev, path) {
      var stat = fs.lstatSync(path);
      var size = stat.size;
      var mtime = stat.mtime;
      var node = FS.createNode(parent, name, mode);
      node.mode = mode;
      node.node_ops = WORKERFS.node_ops;
      node.stream_ops = NODEWORKERFS.stream_ops;
      node.atime = node.mtime = node.ctime = mtime;
      assert(WORKERFS.FILE_MODE !== WORKERFS.DIR_MODE);
      if (mode === WORKERFS.FILE_MODE) {
        node.size = size;
        node.hostpath = path;
      } else {
        // should now go here
        node.size = 4096;
        node.hostpath = null;
      }
      if (parent) {
        parent.contents[name] = node;
      }
      return node;
    },
    stream_ops: {
      ...WORKERFS.stream_ops,
      open(stream) {
        var path = stream.node.hostpath;
        stream.nfd = fs.openSync(path, stream.flags);
      },
      close(stream) {
        fs.closeSync(stream.nfd);
      },
      read(stream, buffer, offset, length, position) {
        return fs.readSync(stream.nfd, buffer, offset, length, position);
      },
    },
  };
  return NODEWORKERFS;
}

function workerFsForGunzip(moduleInstance, runtime) {
  const FS = moduleInstance.FS;
  const WORKERFS = moduleInstance.WORKERFS || FS.filesystems?.WORKERFS;
  if (!WORKERFS) {
    throw new Error('WORKERFS is required for gzip file mapping');
  }

  const GZIPWORKERFS = {
    ...WORKERFS,
    mount(mount) {
      var root = WORKERFS.createNode(null, '/', WORKERFS.DIR_MODE, 0);

      function base(pathname) {
        var parts = String(pathname || '').split('/').filter((part) => !!part);
        return parts[parts.length - 1] || 'input.bin';
      }

      for (var source of (mount.opts['files'] || [])) {
        var virtualName = String(source.name || 'input.bin');
        GZIPWORKERFS.createNode(
          root,
          base(virtualName),
          WORKERFS.FILE_MODE,
          0,
          source,
          source.mtime
        );
      }

      return root;
    },
    createNode(parent, name, mode, dev, source, mtime) {
      var node = FS.createNode(parent, name, mode);
      node.mode = mode;
      node.node_ops = WORKERFS.node_ops;
      node.stream_ops = GZIPWORKERFS.stream_ops;
      node.atime = node.mtime = node.ctime = (mtime || new Date()).getTime();
      assert(WORKERFS.FILE_MODE !== WORKERFS.DIR_MODE);

      if (mode === WORKERFS.FILE_MODE) {
        var gzipSource = resolveGunzipSource(runtime, source);
        node.size = gzipSource.estimatedSize ?? 0;
        node.gzSource = gzipSource;
      } else {
        node.size = 4096;
        node.contents = {};
        node.gzSource = null;
      }

      if (parent) {
        parent.contents[name] = node;
      }

      return node;
    },
    stream_ops: {
      ...WORKERFS.stream_ops,
      open(stream) {
        var gzipSource = stream.node.gzSource;
        if (!gzipSource) {
          throw new Error('gzip source is missing');
        }

        var inputSource = gzipSource.kind === 'path'
          ? gzipSource.path
          : gzipSource.data;
        stream.gzStream = new GzipStream(inputSource);
        stream.gzStream.open();
      },
      close(stream) {
        if (stream.gzStream) {
          stream.gzStream.close();
          stream.gzStream = null;
        }
      },
      read(stream, buffer, offset, length, position) {
        if (!stream.gzStream) {
          throw new Error('gzip stream is not open');
        }

        const bytesRead = stream.gzStream.read(buffer, offset, length, position);
        if (bytesRead > 0 && typeof position === 'number') {
          const endPosition = position + bytesRead;
          if (endPosition > stream.node.size) {
            stream.node.size = endPosition;
          }
        }

        return bytesRead;
      },
    },
  };

  return GZIPWORKERFS;
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

  async function mountFile(name, source, gunzip = false) {
    if (!source) {
      throw new Error('source is required');
    }
    if (!WORKERFS) {
      throw new Error('WORKERFS is required for file mapping');
    }
    const mountName = toMountName(name);
    const mountPoint = `${mountRoot}/${mountName}`;
    ensureDir(FS, mountPoint);

    if (isBrowserRuntime(runtime)) {
      if (gunzip) {
        const browserGunzipMount = resolveBrowserGunzipMount(source, name);
        const GZIPWORKERFS = workerFsForGunzip(moduleInstance, runtime);
        FS.mount(GZIPWORKERFS, browserGunzipMount.mountOptions, mountPoint);
        return `${mountPoint}/${browserGunzipMount.virtualName}`;
      }

      const browserMount = resolveBrowserMount(source, name);
      try {
        FS.mount(WORKERFS, browserMount.mountOptions, mountPoint);
      } catch (error) {
        const errorMessage = String(error && error.message ? error.message : error);
        throw new Error(`Failed to mount source with WORKERFS: ${errorMessage}`);
      }

      return `${mountPoint}/${browserMount.virtualName}`;
    }

    if (isNodeRuntime(runtime)) {
      if (typeof source !== 'string') {
        throw new Error('Node.js runtime requires source to be a local file path string');
      }

      const pathModule = await import('node:path');
      const absolutePath = pathModule.resolve(String(source));
      const baseName = pathModule.basename(absolutePath);

      if (gunzip) {
        const GZIPWORKERFS = workerFsForGunzip(moduleInstance, runtime);
        const virtualName = stripGzipExtension(baseName);
        FS.mount(GZIPWORKERFS, { files: [{ path: absolutePath, name: virtualName }] }, mountPoint);
        return `${mountPoint}/${virtualName}`;
      }

      const NODEWORKERFS = workerFsForNode(moduleInstance);
      FS.mount(NODEWORKERFS, { files: [{path: source, name: baseName}] }, mountPoint);
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
