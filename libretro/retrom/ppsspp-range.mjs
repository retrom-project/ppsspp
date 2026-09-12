export const blockSize = 256 * 1024;
export const ioTimeout = 15000;

export function validateSource(source) {
  if (!source || source.kind !== 'SEEKABLE_BLOB' || source.rangeRequired !== true ||
      !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > 2147483647 ||
      !/^[0-9a-f]{64}$/.test(source.sha256)) throw Error('PPSSPP_DISC_SOURCE_INVALID');
  const url = new URL(source.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('PPSSPP_DISC_SOURCE_INVALID');
}

export async function boundedBytes(response, size) {
  const reader = response.body?.getReader();
  if (!reader) throw Error('PPSSPP_DISC_RANGE_INVALID');
  const bytes = new Uint8Array(size);
  let offset = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if (offset + value.length > size) throw Error('PPSSPP_DISC_RANGE_INVALID');
      bytes.set(value, offset); offset += value.length;
    }
    if (offset !== size) throw Error('PPSSPP_DISC_RANGE_INVALID');
    return bytes;
  } finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}

export class RangeReader {
  constructor(source, {fetcher = globalThis.fetch.bind(globalThis), cache = null, timeout = ioTimeout} = {}) {
    validateSource(source);
    this.source = source; this.fetcher = fetcher; this.cache = cache; this.timeout = timeout;
    this.memory = new Map(); this.pending = new Map(); this.abort = new AbortController();
  }
  async block(index) {
    this.abort.signal.throwIfAborted();
    if (!Number.isSafeInteger(index) || index < 0 || index * blockSize >= this.source.sizeBytes) throw Error('PPSSPP_DISC_BOUNDS');
    if (this.memory.has(index)) {
      const bytes = this.memory.get(index); this.memory.delete(index); this.memory.set(index, bytes); return bytes;
    }
    if (this.pending.has(index)) return this.pending.get(index);
    const promise = this.load(index); this.pending.set(index, promise);
    try {
      const bytes = await promise; this.abort.signal.throwIfAborted();
      this.memory.set(index, bytes);
      if (this.memory.size > 32) this.memory.delete(this.memory.keys().next().value);
      return bytes;
    } finally {this.pending.delete(index);}
  }
  async load(index) {
    const start = index * blockSize, end = Math.min(start + blockSize, this.source.sizeBytes) - 1;
    const size = end - start + 1, key = `${this.source.sha256}-${this.source.sizeBytes}-${blockSize}-${index}`;
    try {
      const cached = await this.cache?.get(key, size);
      if (cached?.length === size) return cached;
    } catch { /* Storage is optional; a failed cache read must still allow a bounded network read. */ }
    this.abort.signal.throwIfAborted();
    const request = new AbortController(), abort = () => request.abort(this.abort.signal.reason);
    this.abort.signal.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => request.abort(Error('PPSSPP_DISC_TIMEOUT')), this.timeout);
    try {
      const etag = `"sha256-${this.source.sha256}"`;
      const response = await this.fetcher(this.source.url, {credentials: 'same-origin', redirect: 'error',
        headers: {Range: `bytes=${start}-${end}`, 'If-Match': etag}, signal: request.signal});
      if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${start}-${end}/${this.source.sizeBytes}` ||
          response.headers.get('ETag') !== etag || response.headers.get('Content-Length') !== String(size)) {
        await response.body?.cancel(); throw Error('PPSSPP_DISC_RANGE_INVALID');
      }
      const bytes = await boundedBytes(response, size);
      request.signal.throwIfAborted();
      try {await this.cache?.put(key, bytes);} catch { /* The verified network response remains usable. */ }
      return bytes;
    } finally {clearTimeout(timer); this.abort.signal.removeEventListener('abort', abort);}
  }
  close() {this.abort.abort(Error('PPSSPP_DISC_CLOSED')); this.memory.clear();}
}
