import {loadContentReader, contentAbi, contractSha256, verifiedAsset} from './ppsspp-content.mjs';
import {mountDisc} from './ppsspp-disc.mjs';
import {decodeSave, nativeSaves, saveRoot} from './ppsspp-save.mjs';

let core, contentReader, canvas, timer, saves, paused = true, stopped = false, ready = false, nextTick = 0;
let commands = Promise.resolve();
const reply = (id, value, transfer = []) => postMessage({id, value}, transfer);
const fail = (id, error) => {postMessage({kind: 'diagnostic', message: error.stack || error.message}); postMessage({id, error: error.message || 'PPSSPP_RUNTIME_FAILED'});};
const ticks = new MessageChannel();
ticks.port1.onmessage = () => loop();
const stopLoop = () => {clearTimeout(timer); timer = undefined; ticks.port1.close(); ticks.port2.close();};
function scheduleLoop(delay) {
  // Message tasks break timer nesting. Otherwise Chromium adds at least 4 ms
  // after near-budget or late frames, even when the requested delay is zero.
  if (delay > 0) timer = setTimeout(() => ticks.port2.postMessage(null), delay);
  else {timer = undefined; ticks.port2.postMessage(null);}
}
function loop() {
  // Ticks and commands share one queue, including async hashing and file exports.
  commands = commands.then(async () => {
    if (stopped) return;
    const start = performance.now();
    try {
      if (!paused) {
        const state = core._psp_step();
        if (!state) throw new Error('PPSSPP_CORE_STOPPED');
        ready = state === 2;
      }
      if (ready) await saves.refresh();
      nextTick = paused ? performance.now() : Math.max(nextTick + core.retromFrameInterval, start);
      scheduleLoop(paused ? 100 : Math.max(0, nextTick - performance.now()));
    } catch (error) {paused = true; fail(0, error);}
  });
}
async function start(value) {
  canvas = value.canvas;
  const restored = value.restore ? decodeSave(value.restore, value.source.sha256) : null;
  const address = crypto.getRandomValues(new Uint8Array(6)); address[0] = (address[0] | 2) & 254;
  const mac = restored?.mac ?? [...address].map(b => b.toString(16).padStart(2, '0')).join(':');
  contentReader = await loadContentReader(value.source, value.content);
  postMessage({kind: 'content-client-ready', abi: contentAbi, contractSha256});
  const {default: createPPSSPP} = await import(verifiedAsset(value.assets, 'ppsspp.js'));
  core = await createPPSSPP({canvas, noInitialRun: true, print: () => {},
    printErr: message => postMessage({kind: 'diagnostic', message}),
    mainScriptUrlOrBlob: verifiedAsset(value.assets, 'ppsspp.js'),
    locateFile: name => verifiedAsset(value.assets, name)});
  core.FS.mkdirTree(saveRoot); core.FS.mkdirTree('/game');
  for (const file of restored?.files ?? []) {
    const path = saveRoot + '/' + file.path;
    core.FS.mkdirTree(path.slice(0, path.lastIndexOf('/'))); core.FS.writeFile(path, file.bytes);
    core.FS.utime(path, file.mtime, file.mtime);
  }
  saves = await nativeSaves(core, {identity: value.source.sha256, mac, restore: restored,
    publish: value => postMessage({kind: 'save-status', value})});
  const path = mountDisc(core.FS, value.source, contentReader);
  if (!core.ccall('psp_start', 'number', ['string', 'string'], [path, mac])) throw new Error('PPSSPP_START_FAILED');
  const deadline = performance.now() + 45000;
  while (!ready) {
    const state = core._psp_step();
    if (!state || performance.now() >= deadline) throw new Error('PPSSPP_START_FAILED');
    ready = state === 2;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  await saves.refresh();
  paused = false; nextTick = performance.now(); loop(); return {ready: true};
}
async function command(type, value) {
  if (type === 'start') return start(value);
  if (!core) {if (type === 'stop') {contentReader?.close(); return;} throw new Error('PPSSPP_NOT_READY');}
  switch (type) {
  case 'input': core._psp_input(value.mask, value.x, value.y); return;
  case 'pause': paused = true; core._psp_pause(); if (ready) await saves.refresh(); return;
  case 'resume': paused = false; nextTick = performance.now(); return;
  case 'checkpoint': {
    if (!ready) throw new Error('PPSSPP_CHECKPOINT_NOT_READY');
    return saves.checkpoint();
  }
  case 'acknowledge': return saves.acknowledge(value);
  case 'screenshot': return canvas.convertToBlob({type: 'image/png'});
  case 'stop':
    paused = true; stopped = true; stopLoop(); saves?.dispose();
    try {core._psp_stop();} finally {contentReader?.close(); core.PThread?.terminateAllThreads();}
    return;
  default: throw new Error('PPSSPP_COMMAND_INVALID');
  }
}
self.onmessage = event => {
  const {id, type, value} = event.data;
  commands = commands.then(async () => {
    try {const result = await command(type, value); reply(id, result, result instanceof Uint8Array ? [result.buffer] : []);}
    catch (error) {fail(id, error);}
  });
};
