import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {verifiedAsset} from '../ppsspp-content.mjs';
import {webcrypto} from 'node:crypto';
import {decodeSave, saveRoot} from '../ppsspp-save.mjs';

async function instance() {
  const messages = [], files = new Map(), timers = [];
  const calls = [], directories = new Set(['/save', '/game']);
  let fd = 0;
  const core = {
    retromFrameInterval: 1000 * 1.001 / 60,
    FS: {mkdirTree: path => {for (let i = 1; i <= path.split('/').length; i++) directories.add(path.split('/').slice(0, i).join('/'));},
      mount: (...args) => calls.push(['mount', ...args]), readFile: path => files.get(path),
      open(path, flags) {return {path, flags, fd: ++fd};},
      write(stream, bytes, offset, size) {files.set(stream.path, bytes.slice(offset, offset + size)); return size;},
      close(stream) {stream.fd = null;},
      writeFile(path, bytes) {const stream = core.FS.open(path, 1); core.FS.write(stream, bytes, 0, bytes.length); core.FS.close(stream);},
      utime: (path, atime, mtime) => calls.push(['mtime', path, mtime]),
      isDir: mode => mode === 1, isFile: mode => mode === 0,
      lstat: path => ({mode: directories.has(path) ? 1 : 0, size: files.get(path)?.length ?? 0, mtime: new Date(1000)}),
      readdir: path => ['.', '..', ...new Set([...files.keys(), ...directories].filter(p => p.startsWith(path + '/')).map(p => p.slice(path.length + 1).split('/')[0]))]},
    ccall: (name, type, types, args) => {calls.push(['boot', ...args, [...files.keys()]]); return 1;},
    _psp_step: () => 2, _psp_pause: () => calls.push(['pause']), _psp_save_ready: () => 1,
    _psp_state_size: () => {throw new Error('must not serialize execution state');},
    _psp_input: (...args) => calls.push(['input', ...args]), _psp_stop: () => calls.push(['stop']),
    PThread: {terminateAllThreads: () => calls.push(['threadsStopped'])},
  };
  const context = vm.createContext({Uint8Array, DataView, TextEncoder, TextDecoder, Blob, performance, crypto: webcrypto,
    setTimeout: (fn, ms) => {if (ms === 0) setImmediate(fn); else timers.push(fn); return 1;}, clearTimeout: () => {}, self: {}, postMessage: msg => messages.push(msg)});
  const source = await readFile(new URL('../ppsspp.worker.mjs', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, {context, importModuleDynamically: async url => {
    assert.equal(url, 'blob:https://core.test/module');
    const native = new vm.SyntheticModule(['default'], function () {this.setExport('default', async options => {
      assert.equal(options.locateFile('ppsspp.wasm'), 'blob:https://core.test/wasm');
      assert.equal(options.locateFile('ppsspp.data'), 'blob:https://core.test/data');
      assert.equal(options.mainScriptUrlOrBlob, url);
      assert.throws(() => options.locateFile('unknown'), /ASSET/); return core;
    });}, {context});
    await native.link(() => {}); await native.evaluate(); return native;
  }});
  await module.link(async specifier => specifier.includes('save') ? new vm.SourceTextModule(
    await readFile(new URL('../ppsspp-save.mjs', import.meta.url), 'utf8'), {context}) : specifier.includes('content') ? new vm.SyntheticModule(['loadContentReader', 'contentAbi', 'contractSha256', 'verifiedAsset'], function () {
    this.setExport('loadContentReader', async () => ({close: () => calls.push(['contentClosed'])}));
    this.setExport('contentAbi', 'content-io-v1'); this.setExport('contractSha256', 'a'.repeat(64));
    this.setExport('verifiedAsset', verifiedAsset);
  }, {context}) : specifier.includes('disc') ? new vm.SyntheticModule(['mountDisc'], function () {
    this.setExport('mountDisc', () => '/game/content.iso');
  }, {context}) : new vm.SyntheticModule(['default'], function () {this.setExport('default', async () => core);}, {context}));
  await module.evaluate();
  async function command(type, value) {
    const id = messages.length + 1; context.self.onmessage({data: {id, type, value}});
    for (let i = 0; i < 100; i++) {await new Promise(resolve => setImmediate(resolve)); if (messages.some(m => m.id === id)) break;}
    const message = messages.find(m => m.id === id); assert.ok(message, 'worker replied');
    if (message.error) throw new Error(message.error); return message.value;
  }
  const start = restore => command('start', {canvas: {}, restore, source: {sha256: 'a'.repeat(64), sizeBytes: 3}, assets: {'ppsspp.js': 'blob:https://core.test/module',
    'ppsspp.wasm': 'blob:https://core.test/wasm', 'ppsspp.data': 'blob:https://core.test/data'}});
  const write = (path, bytes) => {core.FS.mkdirTree(path.slice(0, path.lastIndexOf('/'))); core.FS.writeFile(path, bytes);};
  const tick = async () => {timers.shift()?.(); await command('input', {mask: 0, x: 0, y: 0});};
  return {command, start, calls, files, write, messages, tick};
}
test('worker steps without a submitted video frame never fabricate presentation counts', async () => {
  const worker = await instance(); await worker.start();
  for (let i = 0; i < 40; i++) await worker.tick();
  assert.equal(worker.messages.some(m => m.kind === 'frames'), false);
});
test('native checkpoint restores complete savedata and virtual MAC before boot without loading execution state', async () => {
  const first = await instance(); await first.start();
  first.write(saveRoot + '/PSP/SAVEDATA/SLOT/DATA.BIN', new Uint8Array([9, 8]));
  first.write(saveRoot + '/PSP/TITLE_SAVE.sys', new Uint8Array([7, 6]));
  first.write('/save/PSP/SYSTEM/irrelevant.ini', new Uint8Array([1]));
  const saved = await first.command('checkpoint');
  const second = await instance(); await second.start(saved);
  assert.deepEqual(second.files.get(saveRoot + '/PSP/SAVEDATA/SLOT/DATA.BIN'), new Uint8Array([9, 8]));
  assert.deepEqual(second.files.get(saveRoot + '/PSP/TITLE_SAVE.sys'), new Uint8Array([7, 6]));
  assert.equal(second.files.has('/save/PSP/SYSTEM/irrelevant.ini'), false);
  const archive = decodeSave(saved, 'a'.repeat(64)), boot = second.calls.find(c => c[0] === 'boot');
  assert.equal(boot[2], archive.mac);
  assert.equal(boot[3].includes(saveRoot + '/PSP/SAVEDATA/SLOT/DATA.BIN'), true);
  assert.equal(boot[3].includes(saveRoot + '/PSP/TITLE_SAVE.sys'), true);
  await assert.rejects(second.command('checkpoint'), /SAVE_UNAVAILABLE/);
  await second.command('input', {mask: 1 << 8, x: 12, y: 0});
  assert.deepEqual(second.calls.at(-1), ['input', 256, 12, 0]);
  await second.command('stop'); assert.deepEqual(second.calls.slice(-3), [['stop'], ['contentClosed'], ['threadsStopped']]);
});
test('invalid/truncated and path-escaping snapshots never boot as a new game', async () => {
  const first = await instance(); await first.start(); first.write(saveRoot + '/SLOT/DATA.BIN', Uint8Array.of(1));
  const saved = await first.command('checkpoint');
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
