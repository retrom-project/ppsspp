import createPPSSPP from './ppsspp.js';

let core, canvas, timer, paused = true, ready = false, frames = 0;
const maximum = 256 * 1024 * 1024;
const reply = (id, value, transfer = []) => postMessage({id, value}, transfer);
const fail = (id, error) => {postMessage({kind: 'diagnostic', message: error.stack || error.message}); postMessage({id, error: error.message || 'PPSSPP_RUNTIME_FAILED'});};
const stopLoop = () => {clearTimeout(timer); timer = undefined;};
function loop() {
  if (paused) return;
  const start = performance.now();
  try {
    const state = core._psp_step();
    if (!state) throw new Error('PPSSPP_CORE_STOPPED');
    ready = state === 2;
    frames++;
    if (frames % 30 === 0) postMessage({kind: 'frames', value: frames});
    timer = setTimeout(loop, Math.max(0, 1000 / 60 - (performance.now() - start)));
  } catch (error) {paused = true; fail(0, error);}
}
function nativeBytes(bytes, action) {
  const pointer = core._malloc(bytes.length);
  if (!pointer) throw new Error('PPSSPP_MEMORY_LIMIT');
  try {core.HEAPU8.set(bytes, pointer); return action(pointer);} finally {core._free(pointer);}
}
function filesAt(path = '/save') {
  return core.FS.readdir(path).filter(name => name !== '.' && name !== '..').flatMap(name => {
    const file = path + '/' + name;
    return core.FS.isDir(core.FS.stat(file).mode) ? filesAt(file) : [{path: file.slice(6), bytes: core.FS.readFile(file)}];
  });
}
function encodeState() {
  const size = core._psp_state_size();
  if (!size || size > maximum) throw new Error('PPSSPP_CHECKPOINT_NOT_READY');
  const pointer = core._malloc(size);
  if (!pointer) throw new Error('PPSSPP_MEMORY_LIMIT');
  let state;
  try {
    if (!core._psp_save(pointer, size)) throw new Error('PPSSPP_CHECKPOINT_FAILED');
    state = core.HEAPU8.slice(pointer, pointer + size);
  } finally {core._free(pointer);}
  const files = filesAt();
  const header = new TextEncoder().encode(JSON.stringify({version: 1, stateSize: size, files: files.map(f => ({path: f.path, size: f.bytes.length}))}));
  const length = 4 + header.length + size + files.reduce((n, f) => n + f.bytes.length, 0);
  if (header.length > 1024 * 1024 || length > maximum) throw new Error('PPSSPP_CHECKPOINT_TOO_LARGE');
  const result = new Uint8Array(length);
  new DataView(result.buffer).setUint32(0, header.length, true);
  result.set(header, 4); result.set(state, 4 + header.length);
  let offset = 4 + header.length + size;
  for (const file of files) {result.set(file.bytes, offset); offset += file.bytes.length;}
  return result;
}
function decodeState(bytes) {
  const invalid = () => {throw new Error('PPSSPP_CHECKPOINT_INVALID');};
  if (!(bytes instanceof Uint8Array) || bytes.length < 5 || bytes.length > maximum) invalid();
  const headerSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (!headerSize || headerSize > 1024 * 1024 || headerSize + 4 >= bytes.length) invalid();
  let header;
  try {header = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(4, 4 + headerSize)));} catch {invalid();}
  if (!header || header.version !== 1 || !Number.isSafeInteger(header.stateSize) || header.stateSize < 1 || !Array.isArray(header.files)) invalid();
  let offset = 4 + headerSize + header.stateSize;
  if (offset > bytes.length) invalid();
  const paths = new Set();
  const files = header.files.map(file => {
    if (!file || typeof file.path !== 'string' || !file.path || file.path.split('/').some(p => !p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0')) ||
        paths.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || offset + file.size > bytes.length) invalid();
    paths.add(file.path);
    const value = {path: '/save/' + file.path, bytes: bytes.subarray(offset, offset + file.size)};
    offset += file.size; return value;
  });
  if (offset !== bytes.length) invalid();
  return {files, state: bytes.subarray(4 + headerSize, 4 + headerSize + header.stateSize)};
}
async function start(value) {
  canvas = value.canvas;
  const restored = value.restore ? decodeState(value.restore) : null;
  core = await createPPSSPP({canvas, noInitialRun: true, print: () => {},
    printErr: message => postMessage({kind: 'diagnostic', message}),
    locateFile: name => new URL(name, import.meta.url).href});
  core.FS.mkdirTree('/save'); core.FS.mkdirTree('/game');
  for (const file of restored?.files ?? []) {
    core.FS.mkdirTree(file.path.slice(0, file.path.lastIndexOf('/'))); core.FS.writeFile(file.path, file.bytes);
  }
  const path = '/game/content.' + value.extension;
  core.FS.mount(core.WORKERFS, {blobs: [{name: 'content.' + value.extension, data: value.file}]}, '/game');
  if (!core.ccall('psp_start', 'number', ['string'], [path])) throw new Error('PPSSPP_START_FAILED');
  const deadline = performance.now() + 45000;
  while (!ready) {
    const state = core._psp_step();
    if (!state || performance.now() >= deadline) throw new Error('PPSSPP_START_FAILED');
    ready = state === 2; frames++;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  core._psp_pause();
  if (restored && !nativeBytes(restored.state, pointer => core._psp_load(pointer, restored.state.length))) throw new Error('PPSSPP_RESTORE_FAILED');
  paused = false; loop(); return {ready: true};
}
async function command(type, value) {
  if (type === 'start') return start(value);
  if (!core) throw new Error('PPSSPP_NOT_READY');
  switch (type) {
  case 'input': core._psp_input(value.mask, value.x, value.y); return;
  case 'pause': paused = true; stopLoop(); core._psp_pause(); return;
  case 'resume': if (paused) {paused = false; loop();} return;
  case 'checkpoint': {
    if (!ready) throw new Error('PPSSPP_CHECKPOINT_NOT_READY');
    stopLoop();
    try {return encodeState();} finally {if (!paused) timer = setTimeout(loop, 0);}
  }
  case 'screenshot': return canvas.convertToBlob({type: 'image/png'});
  case 'stop': paused = true; stopLoop(); core._psp_stop(); core.PThread?.terminateAllThreads(); return;
  default: throw new Error('PPSSPP_COMMAND_INVALID');
  }
}
let commands = Promise.resolve();
self.onmessage = event => {
  const {id, type, value} = event.data;
  commands = commands.then(async () => {
    try {const result = await command(type, value); reply(id, result, result instanceof Uint8Array ? [result.buffer] : []);}
    catch (error) {fail(id, error);}
  });
};
