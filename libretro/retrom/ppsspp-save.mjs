export const saveRoot = '/save/PSP/SAVEDATA';
const maximum = 256 * 1024 * 1024, maximumHeader = 1024 * 1024, maximumFiles = 4096;
const invalid = () => {throw new Error('PPSSPP_CHECKPOINT_INVALID');};
const validMac = mac => typeof mac === 'string' && /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(mac) && mac !== '00:00:00:00:00:00';

function validate({identity, mac, files}) {
  if (typeof identity !== 'string' || !/^[a-f0-9]{64}$/.test(identity) || !validMac(mac) ||
      !Array.isArray(files) || files.length > maximumFiles) invalid();
  const paths = new Set();
  for (const file of files) {
    if (!file || typeof file.path !== 'string' || file.path === '.nomedia' || file.path.length > 1024 || file.path.split('/').length > 33 ||
        file.path.split('/').some(p => !p || p === '.' || p === '..' || /[\\\x00-\x1f]/.test(p)) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || file.size > maximum ||
        !Number.isSafeInteger(file.mtime) || file.mtime < 0) invalid();
    const path = file.path.toUpperCase();
    if (paths.has(path)) invalid();
    paths.add(path);
  }
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) invalid();
  }
}

export function encodeSave(save) {
  const {identity, mac} = save;
  const files = [...save.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest = {version: 1, identity, mac, files: files.map(f => ({path: f.path, size: f.bytes?.byteLength, mtime: f.mtime}))};
  validate(manifest);
  if (files.some(f => !(f.bytes instanceof Uint8Array))) invalid();
  const header = new TextEncoder().encode(JSON.stringify(manifest));
  const length = 4 + header.length + files.reduce((n, f) => n + f.bytes.length, 0);
  if (header.length > maximumHeader || length > maximum) invalid();
  const bytes = new Uint8Array(length);
  new DataView(bytes.buffer).setUint32(0, header.length, true); bytes.set(header, 4);
  let offset = 4 + header.length;
  for (const file of files) {bytes.set(file.bytes, offset); offset += file.bytes.length;}
  return bytes;
}

export function decodeSave(bytes, identity) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 5 || bytes.length > maximum) invalid();
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (!size || size > maximumHeader || size + 4 > bytes.length) invalid();
  let header;
  try {header = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(4, 4 + size)));} catch {invalid();}
  if (!header || header.version !== 1 || header.identity !== identity ||
      Object.keys(header).sort().join(',') !== 'files,identity,mac,version') invalid();
  validate(header);
  let offset = 4 + size;
  const files = header.files.map(file => {
    if (offset + file.size > bytes.length) invalid();
    const value = {path: file.path, bytes: bytes.slice(offset, offset + file.size), mtime: file.mtime};
    offset += file.size; return value;
  });
  if (offset !== bytes.length) invalid();
  return {identity, mac: header.mac, files};
}

// Native libc/pthread syscalls use the same FS methods on the emulation worker.
// Observe mutations, including direct sceIo, without polling the whole memory stick.
function observe(FS) {
  let generation = 1;
  const writers = new Set(), originals = new Map();
  const relevant = path => typeof path === 'string' && path.startsWith(saveRoot + '/') && path !== saveRoot + '/.nomedia';
  for (const method of ['open', 'write', 'close', 'truncate', 'unlink', 'rename', 'mkdir', 'rmdir']) {
    if (typeof FS[method] !== 'function') continue;
    const original = FS[method]; originals.set(method, original);
    FS[method] = function (...args) {
      const fd = method === 'close' ? args[0].fd : null;
      const result = original.apply(this, args);
      if (method === 'open') {
        if (relevant(result.path) && (result.flags & 3)) {writers.add(result.fd); generation++;}
      } else if (method === 'close') {
        if (writers.delete(fd)) generation++;
      } else if (method === 'write') {
        if (result > 0 && relevant(args[0].path)) generation++;
      } else if (relevant(args[0]) || method === 'rename' && relevant(args[1])) generation++;
      return result;
    };
  }
  return {generation: () => generation, busy: () => writers.size > 0,
    dispose: () => {for (const [name, original] of originals) FS[name] = original;}};
}

function readFiles(FS, path = saveRoot, depth = 0, budget = {entries: 0, files: 0, bytes: 0}) {
  if (depth > 32) invalid();
  const files = [];
  for (const name of FS.readdir(path).filter(name => name !== '.' && name !== '..').sort()) {
    if (path === saveRoot && name === '.nomedia') continue;
    if (++budget.entries > maximumFiles * 2) invalid();
    const full = path + '/' + name, info = FS.lstat(full);
    if (FS.isDir(info.mode)) files.push(...readFiles(FS, full, depth + 1, budget));
    else {
      if (!FS.isFile(info.mode) || !Number.isSafeInteger(info.size) || info.size < 0 ||
          ++budget.files > maximumFiles || budget.bytes + info.size > maximum) invalid();
      budget.bytes += info.size;
      const bytes = FS.readFile(full);
      if (bytes.length !== info.size) invalid();
      files.push({path: full.slice(saveRoot.length + 1), bytes, mtime: Math.max(0, Math.trunc(+info.mtime))});
    }
  }
  return files;
}

export async function nativeSaves(core, {identity, mac, restore, publish, crypto = globalThis.crypto}) {
  const observed = observe(core.FS);
  const signature = async save => {
    // Preserve native timestamps in the archive, but identical game writes are one revision.
    const bytes = encodeSave({...save, files: save.files.map(file => ({...file, mtime: 0}))});
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  };
  let baseline = restore ? await signature(restore) : '', revision = '', snapshot, scanned = 0, hadSave = Boolean(restore), lastStatus = '';
  const status = (blocker = null) => {
    const value = blocker ? {available: false, blocker} : {available: true, blocker: null, revision};
    const encoded = JSON.stringify(value);
    if (encoded !== lastStatus) {lastStatus = encoded; publish(value);}
  };
  const refresh = async () => {
    // Utility IO can begin before opening a file. Check that independently of FS dirtiness.
    if (observed.busy() || !core._psp_save_ready(0)) {status('BUSY'); return;}
    if (observed.generation() === scanned) {status(!snapshot ? 'NO_SAVE' : revision === baseline ? 'UNCHANGED' : null); return;}
    if (!core._psp_save_ready(1)) {status('BUSY'); return;}
    const generation = observed.generation(), files = readFiles(core.FS);
    if (!files.length && !hadSave) {scanned = generation; status('NO_SAVE'); return;}
    const save = {identity, mac, files}, next = await signature(save);
    snapshot = encodeSave(save); revision = next; hadSave = true; scanned = generation;
    status(revision === baseline ? 'UNCHANGED' : null);
  };
  return {
    refresh, dispose: observed.dispose,
    async checkpoint() {
      // Even an already cached complete revision must wait for a newer in-flight write.
      if (observed.busy() || !core._psp_save_ready(1)) throw new Error('PPSSPP_SAVE_BUSY');
      await refresh();
      if (!snapshot || revision === baseline) throw new Error('PPSSPP_SAVE_UNAVAILABLE');
      return snapshot.slice();
    },
    async acknowledge(bytes) {
      baseline = await signature(decodeSave(bytes, identity));
      await refresh();
    },
  };
}
