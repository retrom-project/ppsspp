import {blockSize, ioTimeout, validateSource} from './ppsspp-range.mjs';

export function createDiscIO(win, source, onFailure) {
  validateSource(source);
  const buffer = new win.SharedArrayBuffer(16 + blockSize), control = new Int32Array(buffer, 0, 4);
  const {port1, port2} = new win.MessageChannel();
  let worker;
  const close = () => {
    Atomics.store(control, 2, 1); Atomics.store(control, 0, -1); Atomics.notify(control, 0);
    worker?.terminate(); port1.close(); port2.close();
  };
  try {
    worker = new win.Worker(new URL('./ppsspp-io.worker.mjs', import.meta.url), {type: 'module'});
    worker.onerror = () => {close(); onFailure(Error('PPSSPP_DISC_WORKER_FAILED'));};
    worker.onmessage = ({data}) => {if (data.error) {close(); onFailure(Error(data.error));}};
    worker.postMessage({source, buffer, port: port2}, [port2]);
    return {buffer, port: port1, close};
  } catch (error) {close(); throw error;}
}

export function discReader(source, buffer, port, wait = Atomics.wait) {
  validateSource(source);
  const control = new Int32Array(buffer, 0, 4), data = new Uint8Array(buffer, 16), memory = new Map();
  function block(index) {
    if (Atomics.load(control, 2)) throw Error('PPSSPP_DISC_CLOSED');
    if (memory.has(index)) {
      const bytes = memory.get(index); memory.delete(index); memory.set(index, bytes); return bytes;
    }
    Atomics.store(control, 0, 0); port.postMessage(index);
    const deadline = performance.now() + ioTimeout + 1000;
    while (Atomics.load(control, 0) === 0 && !Atomics.load(control, 2)) {
      const remaining = deadline - performance.now();
      if (remaining <= 0 || wait(control, 0, 0, remaining) === 'timed-out') {
        Atomics.store(control, 2, 1); throw Error('PPSSPP_DISC_TIMEOUT');
      }
    }
    if (Atomics.load(control, 2) || Atomics.load(control, 0) !== 1) throw Error('PPSSPP_DISC_READ_FAILED');
    const length = Math.min(blockSize, source.sizeBytes - index * blockSize);
    if (Atomics.load(control, 1) !== length) throw Error('PPSSPP_DISC_RANGE_INVALID');
    const bytes = data.slice(0, length); memory.set(index, bytes);
    if (memory.size > 8) memory.delete(memory.keys().next().value);
    return bytes;
  }
  return (output, offset, length, position) => {
    if (![offset, length, position].every(Number.isSafeInteger) || Math.min(offset, length, position) < 0 ||
        offset + length > output.length) throw Error('PPSSPP_DISC_BOUNDS');
    const count = Math.max(0, Math.min(length, source.sizeBytes - position));
    let done = 0;
    while (done < count) {
      const start = position + done, bytes = block(Math.floor(start / blockSize)), within = start % blockSize;
      const size = Math.min(count - done, bytes.length - within);
      output.set(bytes.subarray(within, within + size), offset + done); done += size;
    }
    return count;
  };
}

export function mountDisc(FS, source, buffer, port) {
  const read = discReader(source, buffer, port), magic = new Uint8Array(8);
  read(magic, 0, Math.min(8, source.sizeBytes), 0);
  const header = Array.from(magic, value => String.fromCharCode(value)).join('');
  const extension = header.startsWith('\0PBP') ? 'pbp' : header.startsWith('CISO') ? 'cso' :
    header === 'MComprHD' ? 'chd' : header.startsWith('\x7fELF') ? 'elf' : 'iso';
  const path = `/game/content.${extension}`;
  FS.createDataFile('/game', `content.${extension}`, new Uint8Array(), true, false);
  const node = FS.lookupPath(path).node;
  const getattr = node.node_ops.getattr;
  node.node_ops = {...node.node_ops, getattr: value => ({...getattr(value), size: source.sizeBytes, blocks: Math.ceil(source.sizeBytes / 4096)})};
  node.stream_ops = {
    read: (_stream, output, offset, length, position) => read(output, offset, length, position),
    llseek: (stream, offset, whence) => {
      const position = offset + (whence === 1 ? stream.position : whence === 2 ? source.sizeBytes : 0);
      if (![0, 1, 2].includes(whence) || !Number.isSafeInteger(position) || position < 0) throw new FS.ErrnoError(28);
      return position;
    },
  };
  return path;
}
