import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function instance() {
  const messages = [], files = new Map(), native = new Uint8Array([1, 2, 3, 4]), memory = new Uint8Array(1024);
  const calls = [], directories = new Set(['/save', '/game']);
  const core = {
    FS: {mkdirTree: path => directories.add(path), mount: (...args) => calls.push(['mount', ...args]),
      writeFile: (path, bytes) => files.set(path, bytes.slice()), readFile: path => files.get(path),
      isDir: mode => mode === 1, stat: path => ({mode: directories.has(path) ? 1 : 0}),
      readdir: path => ['.', '..', ...new Set([...files.keys(), ...directories].filter(p => p.startsWith(path + '/')).map(p => p.slice(path.length + 1).split('/')[0]))]},
    HEAPU8: memory, WORKERFS: {}, _malloc: () => 16, _free: () => {}, ccall: () => 1,
    _psp_step: () => 2, _psp_pause: () => calls.push(['pause']), _psp_state_size: () => 4,
    _psp_save: pointer => {memory.set(native, pointer); return 1;},
    _psp_load: (pointer, size) => {calls.push(['restore', ...memory.slice(pointer, pointer + size)]); return 1;},
    _psp_input: (...args) => calls.push(['input', ...args]), _psp_stop: () => calls.push(['stop']),
    PThread: {terminateAllThreads: () => calls.push(['threadsStopped'])},
  };
  const context = vm.createContext({Uint8Array, DataView, TextEncoder, TextDecoder, Blob, performance,
    setTimeout: (fn, ms) => {if (ms === 0) setImmediate(fn); return 1;}, clearTimeout: () => {}, self: {}, postMessage: msg => messages.push(msg)});
  const source = await readFile(new URL('../ppsspp.worker.mjs', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, {context, initializeImportMeta: meta => {meta.url = 'http://localhost/core/';}});
  await module.link(() => new vm.SyntheticModule(['default'], function () {this.setExport('default', async () => core);}, {context}));
  await module.evaluate();
  async function command(type, value) {
    const id = messages.length + 1; context.self.onmessage({data: {id, type, value}});
    for (let i = 0; i < 100; i++) {await new Promise(resolve => setImmediate(resolve)); if (messages.some(m => m.id === id)) break;}
    const message = messages.find(m => m.id === id); assert.ok(message, 'worker replied');
    if (message.error) throw new Error(message.error); return message.value;
  }
  const start = restore => command('start', {canvas: {}, file: new Blob(['game']), extension: 'iso', restore});
  return {command, start, calls, files};
}
test('checkpoint restores native state and memory stick before boot in a new instance', async () => {
  const first = await instance(); await first.start();
  first.files.set('/save/settings.ini', new Uint8Array([9, 8]));
  const saved = await first.command('checkpoint');
  const second = await instance(); await second.start(saved);
  assert.deepEqual(second.files.get('/save/settings.ini'), new Uint8Array([9, 8]));
  assert.deepEqual(second.calls.find(c => c[0] === 'restore'), ['restore', 1, 2, 3, 4]);
  await second.command('input', {mask: 1 << 8, x: 12, y: 0});
  assert.deepEqual(second.calls.at(-1), ['input', 256, 12, 0]);
  await second.command('stop'); assert.deepEqual(second.calls.slice(-2), [['stop'], ['threadsStopped']]);
});
test('invalid/truncated and path-escaping snapshots never boot as a new game', async () => {
  const first = await instance(); await first.start(); const saved = await first.command('checkpoint');
  const bad = saved.slice(0, -1); await assert.rejects((await instance()).start(bad), /CHECKPOINT_INVALID/);
  const header = new TextEncoder().encode(JSON.stringify({version: 1, stateSize: 1, files: [{path: '../escape', size: 1}]}));
  const bytes = new Uint8Array(4 + header.length + 2); new DataView(bytes.buffer).setUint32(0, header.length, true); bytes.set(header, 4);
  const next = await instance(); await assert.rejects(next.start(bytes), /CHECKPOINT_INVALID/); assert.equal(next.calls.length, 0);
});

test('malformed JSON and null records have a stable checkpoint error before boot', async () => {
  for (const json of ['null', '{', '{"version":1,"stateSize":1,"files":[null]}']) {
    const header = new TextEncoder().encode(json), bytes = new Uint8Array(5 + header.length);
    new DataView(bytes.buffer).setUint32(0, header.length, true); bytes.set(header, 4);
    const next = await instance(); await assert.rejects(next.start(bytes), /CHECKPOINT_INVALID/);
    assert.equal(next.calls.length, 0);
  }
});
