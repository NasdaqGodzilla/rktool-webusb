const DEFAULT_PREFIX_CACHE_SIZE = 4 * 1024;
const DEFAULT_COMPRESSED_CHUNK_SIZE = 64 * 1024;

function isNodeRuntime() {
	return typeof process !== 'undefined' && !!(process.versions && process.versions.node);
}

let nodeRequire = null;
if (isNodeRuntime()) {
	const { createRequire } = await import('node:module');
	nodeRequire = createRequire(import.meta.url);
}

function normalizeSize(value, fallback) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return fallback;
	}
	return Math.trunc(parsed);
}

function normalizePositiveSize(value, fallback) {
	const size = normalizeSize(value, fallback);
	if (size <= 0) {
		return fallback;
	}
	return size;
}

function toUint8Array(chunk) {
	if (!chunk) {
		return new Uint8Array(0);
	}
	if (chunk instanceof Uint8Array) {
		return chunk;
	}
	if (ArrayBuffer.isView(chunk)) {
		return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	}
	if (chunk instanceof ArrayBuffer) {
		return new Uint8Array(chunk);
	}
	return Uint8Array.from(chunk);
}

function concatChunks(chunks, totalLength) {
	const result = new Uint8Array(totalLength);
	let writeOffset = 0;
	for (const chunk of chunks) {
		result.set(chunk, writeOffset);
		writeOffset += chunk.byteLength;
	}
	return result;
}

function toWritableView(buffer) {
	if (buffer instanceof Uint8Array) {
		return buffer;
	}
	if (ArrayBuffer.isView(buffer)) {
		return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	}
	if (buffer instanceof ArrayBuffer) {
		return new Uint8Array(buffer);
	}
	throw new Error('buffer must be a Uint8Array, Buffer, TypedArray, or ArrayBuffer');
}

function isWorkerLikeRuntime() {
	return typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope;
}

export function readGzipISizeFromPath(pathname) {
	if (!nodeRequire || !pathname) {
		return null;
	}

	const fs = nodeRequire('node:fs');
	let fd = null;

	try {
		const stat = fs.statSync(pathname);
		if (!stat || typeof stat.size !== 'number' || stat.size < 4) {
			return null;
		}

		fd = fs.openSync(pathname, 'r');
		const trailer = Buffer.allocUnsafe(4);
		const bytesRead = fs.readSync(fd, trailer, 0, 4, stat.size - 4);
		if (bytesRead !== 4) {
			return null;
		}

		return trailer.readUInt32LE(0);
	} catch (_error) {
		return null;
	} finally {
		if (fd !== null) {
			try {
				fs.closeSync(fd);
			} catch (_closeError) {
			}
		}
	}
}

export function readGzipISizeFromBlob(blob) {
	if (
		!blob
		|| typeof blob !== 'object'
		|| typeof blob.size !== 'number'
		|| blob.size < 4
		|| typeof blob.slice !== 'function'
		|| typeof FileReaderSync !== 'function'
	) {
		return null;
	}

	try {
		const reader = new FileReaderSync();
		const trailer = blob.slice(blob.size - 4, blob.size);
		const bytes = reader.readAsArrayBuffer(trailer);
		if (!bytes || bytes.byteLength < 4) {
			return null;
		}

		return new DataView(bytes).getUint32(0, true);
	} catch (_error) {
		return null;
	}
}

class NodeChunkReader {
	constructor(filePath, chunkSize) {
		if (!nodeRequire) {
			throw new Error('Node.js require is unavailable for sync source reading');
		}
		const fs = nodeRequire('node:fs');
		this.fs = fs;
		this.fd = fs.openSync(filePath, 'r');
		const stat = fs.fstatSync(this.fd);
		this.size = normalizeSize(stat.size, 0);
		this.offset = 0;
		this.eof = this.size === 0;
		this._scratch = Buffer.allocUnsafe(chunkSize);
	}

	readChunk() {
		if (this.offset >= this.size) {
			this.eof = true;
			return null;
		}

		const maxRead = Math.min(this._scratch.byteLength, this.size - this.offset);
		const bytesRead = this.fs.readSync(this.fd, this._scratch, 0, maxRead, this.offset);
		if (bytesRead <= 0) {
			this.offset = this.size;
			this.eof = true;
			return null;
		}

		this.offset += bytesRead;
		this.eof = this.offset >= this.size;
		const view = new Uint8Array(this._scratch.buffer, this._scratch.byteOffset, bytesRead);
		return Uint8Array.from(view);
	}

	close() {
		if (this.fd == null) {
			return;
		}
		this.fs.closeSync(this.fd);
		this.fd = null;
	}
}

class BlobChunkReader {
	constructor(source, chunkSize) {
		if (!source || typeof source !== 'object') {
			throw new Error('Browser source must be a File/Blob-like object');
		}
		if (typeof source.slice !== 'function') {
			throw new Error('Browser source must provide Blob.slice() for sync reading');
		}
		if (typeof FileReaderSync !== 'function') {
			throw new Error('FileReaderSync is required for sync browser gzip reading (Worker runtime only)');
		}

		this.source = source;
		this.reader = new FileReaderSync();
		this.size = normalizeSize(source.size, 0);
		this.offset = 0;
		this.eof = this.size === 0;
		this.chunkSize = chunkSize;
	}

	readChunk() {
		if (this.offset >= this.size) {
			this.eof = true;
			return null;
		}

		const end = Math.min(this.offset + this.chunkSize, this.size);
		const blob = this.source.slice(this.offset, end);
		const arrayBuffer = this.reader.readAsArrayBuffer(blob);
		this.offset = end;
		this.eof = this.offset >= this.size;
		return new Uint8Array(arrayBuffer);
	}

	close() {
	}
}

function resolvePakoInflateCtor(runtime) {
	if (runtime === 'node' && nodeRequire) {
		try {
			const pako = nodeRequire('pako');
			if (typeof pako?.Inflate === 'function') {
				return pako.Inflate;
			}
		} catch (_error) {
		}
	}

	if (typeof globalThis.pako?.Inflate === 'function') {
		return globalThis.pako.Inflate;
	}

	return null;
}

function createPakoInflater(runtime, onData) {
	const InflateCtor = resolvePakoInflateCtor(runtime);
	if (!InflateCtor) {
		throw new Error('Streaming gunzip requires pako (install `pako` in Node.js or provide globalThis.pako.Inflate in Worker)');
	}

	const inflater = new InflateCtor({ gzip: true });
	inflater.onData = (chunk) => {
		onData(toUint8Array(chunk));
	};

	return {
		push(chunk, isLast) {
			inflater.push(chunk, isLast === true);
			if (inflater.err) {
				throw new Error(inflater.msg || `gzip inflate failed (${inflater.err})`);
			}
		},
		close() {
		},
	};
}

export class GzipStream {
	constructor(source, options = {}) {
		this.source = source;
		this.uncompressedSize = typeof source === 'string'
			? readGzipISizeFromPath(source)
			: readGzipISizeFromBlob(source);
		this.prefixCacheSize = normalizeSize(options.prefixCacheSize, DEFAULT_PREFIX_CACHE_SIZE);
		this.compressedChunkSize = normalizePositiveSize(
			options.compressedChunkSize,
			DEFAULT_COMPRESSED_CHUNK_SIZE
		);
		this.createInflater = typeof options.createInflater === 'function'
			? options.createInflater
			: null;

		this._opened = false;
		this._runtime = null;

		this._prefixCache = new Uint8Array(0);
		this._sequentialPosition = 0;
		this._queue = [];
		this._queueLength = 0;
		this._ended = false;

		this._sourceReader = null;
		this._inflater = null;
	}

	open() {
		if (this._opened) {
			return;
		}

		this._resetReadState();

		try {
			if (typeof this.source === 'string') {
				if (!isNodeRuntime()) {
					throw new Error('Node.js file path source is only supported in Node.js runtime');
				}
				this._runtime = 'node';
				this._sourceReader = new NodeChunkReader(this.source, this.compressedChunkSize);
			} else {
				if (!isWorkerLikeRuntime()) {
					throw new Error('Sync browser gzip reading is only supported in Worker runtime');
				}
				this._runtime = 'browser';
				this._sourceReader = new BlobChunkReader(this.source, this.compressedChunkSize);
			}

			this._inflater = this._createInflater((chunk) => this._enqueue(chunk));

			this._prefetchPrefix();
			this._sequentialPosition = this._prefixCache.byteLength;
			this._opened = true;
		} catch (error) {
			this._teardown();
			throw error;
		}
	}

	close() {
		this._teardown();
		this._opened = false;
	}

	read(buffer, offset, length, position) {
		if (!this._opened) {
			throw new Error('GzipStream is not open');
		}

		const target = toWritableView(buffer);
		const targetOffset = normalizeSize(offset, 0);
		if (targetOffset < 0 || targetOffset > target.byteLength) {
			throw new Error('offset is out of range');
		}

		const maxLength = target.byteLength - targetOffset;
		const requestedLength = Math.min(normalizeSize(length, 0), maxLength);
		if (requestedLength <= 0) {
			return 0;
		}

		const requestedPosition = position == null
			? this._sequentialPosition
			: normalizeSize(position, 0);

		if (requestedPosition < 0) {
			throw new Error('position is out of range');
		}

		let totalRead = 0;
		let writeOffset = targetOffset;
		let currentPosition = requestedPosition;

		if (currentPosition < this._prefixCache.byteLength) {
			const availableInPrefix = this._prefixCache.byteLength - currentPosition;
			const copyLength = Math.min(requestedLength, availableInPrefix);
			target.set(
				this._prefixCache.subarray(currentPosition, currentPosition + copyLength),
				writeOffset
			);
			totalRead += copyLength;
			writeOffset += copyLength;
			currentPosition += copyLength;
		}

		const remaining = requestedLength - totalRead;
		if (remaining <= 0) {
			return totalRead;
		}

		if (currentPosition !== this._sequentialPosition) {
			const atKnownEof = this._ended && this._queueLength === 0 && currentPosition >= this._sequentialPosition;
			if (!atKnownEof) {
				throw new Error('Gzip stream is non-seekable; reads beyond cached prefix must be sequential');
			}
			return totalRead;
		}

		this._ensureQueueBytes(remaining);
		const copiedFromQueue = this._consumeQueue(target, writeOffset, remaining);
		this._sequentialPosition += copiedFromQueue;
		totalRead += copiedFromQueue;

		return totalRead;
	}

	_createInflater(onData) {
		if (this.createInflater) {
			const customInflater = this.createInflater({
				runtime: this._runtime,
				source: this.source,
				onData,
			});
			if (!customInflater || typeof customInflater.push !== 'function') {
				throw new Error('createInflater() must return an object with push(chunk, isLast)');
			}
			return customInflater;
		}

		return createPakoInflater(this._runtime, onData);
	}

	_prefetchPrefix() {
		if (this.prefixCacheSize <= 0) {
			this._prefixCache = new Uint8Array(0);
			return;
		}

		const chunks = [];
		let totalLength = 0;

		while (totalLength < this.prefixCacheSize) {
			if (this._queueLength === 0) {
				if (this._ended) {
					break;
				}
				this._pumpCompressedChunk();
				continue;
			}

			const remaining = this.prefixCacheSize - totalLength;
			const tmp = new Uint8Array(Math.min(remaining, this._queueLength));
			const copied = this._consumeQueue(tmp, 0, tmp.byteLength);
			if (copied <= 0) {
				break;
			}

			chunks.push(copied === tmp.byteLength ? tmp : tmp.subarray(0, copied));
			totalLength += copied;
		}

		this._prefixCache = concatChunks(chunks, totalLength);
	}

	_ensureQueueBytes(minimum) {
		while (this._queueLength < minimum && !this._ended) {
			this._pumpCompressedChunk();
		}
	}

	_pumpCompressedChunk() {
		if (this._ended || !this._sourceReader || !this._inflater) {
			return;
		}

		const chunk = this._sourceReader.readChunk();
		if (!chunk || chunk.byteLength === 0) {
			this._inflater.push(new Uint8Array(0), true);
			this._ended = true;
			return;
		}

		const isLast = this._sourceReader.eof;
		this._inflater.push(chunk, isLast);
		if (isLast) {
			this._ended = true;
		}
	}

	_enqueue(chunk) {
		if (!chunk || chunk.byteLength === 0) {
			return;
		}
		this._queue.push(chunk);
		this._queueLength += chunk.byteLength;
	}

	_consumeQueue(target, offset, length) {
		let remaining = length;
		let writeOffset = offset;
		let totalCopied = 0;

		while (remaining > 0 && this._queue.length > 0) {
			const current = this._queue[0];
			const copyLength = Math.min(remaining, current.byteLength);

			target.set(current.subarray(0, copyLength), writeOffset);

			totalCopied += copyLength;
			writeOffset += copyLength;
			remaining -= copyLength;
			this._queueLength -= copyLength;

			if (copyLength === current.byteLength) {
				this._queue.shift();
			} else {
				this._queue[0] = current.subarray(copyLength);
			}
		}

		return totalCopied;
	}

	_resetReadState() {
		this._prefixCache = new Uint8Array(0);
		this._sequentialPosition = 0;
		this._queue = [];
		this._queueLength = 0;
		this._ended = false;
	}

	_teardown() {
		if (this._inflater && typeof this._inflater.close === 'function') {
			try {
				this._inflater.close();
			} catch (_error) {
			}
		}

		if (this._sourceReader && typeof this._sourceReader.close === 'function') {
			try {
				this._sourceReader.close();
			} catch (_error) {
			}
		}

		this._sourceReader = null;
		this._inflater = null;
		this._runtime = null;
		this._resetReadState();
	}
}

export default GzipStream;
