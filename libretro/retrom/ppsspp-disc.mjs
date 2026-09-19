// Native FS facade only: the runtime supplies the public synchronous Reader.
export function discReader(source, reader) {
  if (!source || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1 || source.sizeBytes > 2147483647 ||
      typeof reader?.readInto !== 'function') throw Error('CONTENT_IO_SOURCE_INVALID');
  return (output, offset, length, position) => {
    if (![offset, length, position].every(Number.isSafeInteger) || Math.min(offset, length, position) < 0 ||
        offset > output.length || length > output.length - offset) throw Error('CONTENT_IO_BOUNDS');
    const count = Math.max(0, Math.min(length, source.sizeBytes - position));
    // EOF still observes revocation; no facade or native warm path bypasses the service.
    if (!count) {reader.readInto(Math.min(position, source.sizeBytes), output.subarray(offset, offset)); return 0;}
    const deadline = performance.now() + 15000;
    for (let done = 0; done < count;) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) {reader.close(); throw Error('CONTENT_IO_TIMEOUT');}
      const size = Math.min(262144, count - done);
      if (reader.readInto(position + done, output.subarray(offset + done, offset + done + size), remaining) !== size) {
        reader.close(); throw Error('CONTENT_IO_LENGTH_MISMATCH');
      }
      done += size;
    }
    return count;
  };
}

export function mountDisc(FS, source, reader) {
  const read = discReader(source, reader), magic = new Uint8Array(8);
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
