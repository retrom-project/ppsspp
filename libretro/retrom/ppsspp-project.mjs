import {discReader} from './ppsspp-disc.mjs';

const invalid = () => {throw Error('PPSSPP_PROJECT_INVALID');};
const safePath = path => typeof path === 'string' && path.length > 0 && path.length <= 1024 &&
  path.split('/').every(part => part && part !== '.' && part !== '..' && !/[\\\x00-\x1f]/.test(part));

// Retrom supplies an immutable STORE ZIP. Only its bounded directory is read at
// mount time; native file reads continue through the same single Range reader.
export function projectMembers(source, reader) {
  const range = discReader(source, reader);
  const read = (position, length) => {
    const bytes = new Uint8Array(length);
    if (range(bytes, 0, length, position) !== length) invalid();
    return bytes;
  };
  const tail = read(Math.max(0, source.sizeBytes - 65557), Math.min(source.sizeBytes, 65557));
  const end = new DataView(tail.buffer);
  let at = tail.length - 22;
  while (at >= 0 && (end.getUint32(at, true) !== 0x06054b50 || at + 22 + end.getUint16(at + 20, true) !== tail.length)) at--;
  if (at < 0 || end.getUint16(at + 4, true) || end.getUint16(at + 6, true)) invalid();
  const count = end.getUint16(at + 10, true), size = end.getUint32(at + 12, true), offset = end.getUint32(at + 16, true);
  if (!count || count > 50000 || end.getUint16(at + 8, true) !== count || size > 16 * 1024 * 1024 ||
      offset + size > source.sizeBytes - tail.length + at) invalid();
  const directory = read(offset, size), view = new DataView(directory.buffer), names = new Set(), members = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > size || view.getUint32(cursor, true) !== 0x02014b50 ||
        view.getUint16(cursor + 8, true) & 1 || view.getUint16(cursor + 10, true) !== 0) invalid();
    const length = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true);
    if (cursor + 46 + length + extra + comment > size) invalid();
    const path = new TextDecoder('utf-8', {fatal: true}).decode(directory.subarray(cursor + 46, cursor + 46 + length));
    const key = path.toUpperCase(), bytes = view.getUint32(cursor + 24, true), start = view.getUint32(cursor + 42, true);
    if (!safePath(path) || names.has(key) || view.getUint32(cursor + 20, true) !== bytes || start + 30 > offset) invalid();
    names.add(key);
    const local = new DataView(read(start, 30).buffer);
    if (local.getUint32(0, true) !== 0x04034b50 || local.getUint16(8, true) !== 0 || local.getUint16(6, true) & 1) invalid();
    const dataOffset = start + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    if (dataOffset + bytes > offset || local.getUint16(26, true) !== length ||
        new TextDecoder().decode(read(start + 30, length)) !== path) invalid();
    members.push({path, sizeBytes: bytes, offset: dataOffset});
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== size || members.some(member => member.path.split('/').slice(0, -1)
    .some((_, i, parts) => names.has(parts.slice(0, i + 1).join('/').toUpperCase())))) invalid();
  return {members, range};
}

export function mountProject(FS, source, reader, entryPath) {
  if (!safePath(entryPath)) invalid();
  const {members, range} = projectMembers(source, reader);
  const entry = members.find(member => member.path === entryPath);
  if (!entry || entry.sizeBytes < 4) invalid();
  const magic = new Uint8Array(4); range(magic, 0, 4, entry.offset);
  if (magic[0] !== 0 || String.fromCharCode(...magic.subarray(1)) !== 'PBP') invalid();
  const root = '/save/PSP/GAME/content';
  for (const member of members) mountMember(FS, root + '/' + member.path, member, range);
  return root + '/' + entryPath;
}

function mountMember(FS, path, member, range) {
  // Restored native progress overrides a supplied initial file at the same path.
  if (FS.analyzePath(path).exists) return;
  const parent = path.slice(0, path.lastIndexOf('/')), name = path.slice(path.lastIndexOf('/') + 1);
  FS.mkdirTree(parent); FS.createDataFile(parent, name, new Uint8Array(), true, true);
  const node = FS.lookupPath(path).node, ops = node.stream_ops, nodeOps = node.node_ops;
  node.retromImmutable = true;
  const overlay = size => {
    if (!node.retromImmutable) return;
    if (size > 256 * 1024 * 1024) throw new FS.ErrnoError(27);
    const bytes = new Uint8Array(size), copied = Math.min(size, member.sizeBytes);
    if (copied) range(bytes, 0, copied, member.offset);
    node.contents = bytes; node.usedBytes = size; node.retromImmutable = false;
  };
  node.node_ops = {...nodeOps,
    getattr: value => ({...nodeOps.getattr(value), ...(node.retromImmutable ? {size: member.sizeBytes, blocks: Math.ceil(member.sizeBytes / 4096)} : {})}),
    setattr: (value, attributes) => {if (typeof attributes.size === 'number') overlay(attributes.size); return nodeOps.setattr(value, attributes);},
  };
  node.stream_ops = {...ops,
    read: (stream, output, offset, length, position) => node.retromImmutable
      ? range(output, offset, Math.max(0, Math.min(length, member.sizeBytes - position)), member.offset + Math.min(position, member.sizeBytes))
      : ops.read(stream, output, offset, length, position),
    write: (stream, input, offset, length, position, canOwn) => {
      overlay(Math.max(member.sizeBytes, position + length));
      return ops.write(stream, input, offset, length, position, canOwn);
    },
    llseek: (stream, offset, whence) => {
      const size = node.retromImmutable ? member.sizeBytes : node.usedBytes;
      const position = offset + (whence === 1 ? stream.position : whence === 2 ? size : 0);
      if (![0, 1, 2].includes(whence) || !Number.isSafeInteger(position) || position < 0) throw new FS.ErrnoError(28);
      return position;
    },
  };
}
