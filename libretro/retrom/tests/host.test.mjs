import {contentAbi, contractSha256, validateContent, verifiedAsset} from '../ppsspp-content.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function host(createAudio, Worker) {
  const context = vm.createContext({URL});
  const source = await readFile(new URL('../ppsspp-host.mjs', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, {context, initializeImportMeta: meta => {meta.url = 'https://core.test/ppsspp-host.mjs';}});
  await module.link(specifier => specifier.includes('content') ? new vm.SyntheticModule(['contentAbi', 'contractSha256', 'validateContent', 'verifiedAsset'], function () {
    this.setExport('contentAbi', contentAbi); this.setExport('contractSha256', contractSha256); this.setExport('validateContent', validateContent);
    this.setExport('verifiedAsset', verifiedAsset);
  }, {context}) : new vm.SyntheticModule([specifier.includes('input') ? 'installInput' : 'createAudio'], function () {
    this.setExport(specifier.includes('input') ? 'installInput' : 'createAudio', specifier.includes('input') ? () => ({stop() {}, pause() {}}) : createAudio);
  }, {context}));
  await module.evaluate();
  const children = [], canvas = {focus() {}, transferControlToOffscreen: () => ({}), remove() {children.splice(children.indexOf(canvas), 1);}};
  const target = {append: value => children.push(value), ownerDocument: {defaultView: {Worker, setTimeout, clearTimeout}, createElement: () => canvas}};
  return {children, start: () => module.namespace.createPPSSPPHost({target, source: {sha256: 'a'.repeat(64), sizeBytes: 3},
    assets: {'ppsspp.worker.mjs': 'blob:https://core.test/worker', 'ppsspp.js': 'blob:https://core.test/module',
      'ppsspp.wasm': 'blob:https://core.test/wasm', 'ppsspp.data': 'blob:https://core.test/data'},
    content: {abi: contentAbi, contractSha256, sizeBytes: 3, objectKey: 'b'.repeat(64), syncClientUrl: 'blob:https://core.test/client',
      buffer: new SharedArrayBuffer(262208), port: {postMessage() {}}}})};
}
test('failed worker/audio construction releases the canvas and any created worker', async () => {
  const unavailable = await host(() => ({}), class {constructor() {throw Error('Worker unavailable');}});
  await assert.rejects(unavailable.start(), /Worker unavailable/); assert.equal(unavailable.children.length, 0);
  let terminated = false;
  const unsupported = await host(() => {throw Error('Audio unavailable');}, class {terminate() {terminated = true;}});
  await assert.rejects(unsupported.start(), /Audio unavailable/); assert.equal(unsupported.children.length, 0); assert.equal(terminated, true);
});
test('starts only the Provider-verified worker URL', async () => {
  let url;
  const core = await host(() => ({}), class {constructor(value) {url = String(value); throw Error('stop after URL observation');}});
  await assert.rejects(core.start(), /stop after URL observation/);
  assert.equal(url, 'blob:https://core.test/worker');
});
test('availability reads cached worker status and acknowledges only the exported bytes', async () => {
  let worker, terminated = false;
  const calls = [];
  const owner = await host(() => ({stop: async () => {}, push() {}}), class {
    constructor() {worker = this;}
    terminate() {terminated = true;}
    postMessage(message) {
      calls.push(message);
      queueMicrotask(() => {
        if (message.type === 'start') this.onmessage({data: {kind: 'content-client-ready', abi: contentAbi, contractSha256}});
        if (message.type === 'acknowledge') this.onmessage({data: {kind: 'save-status', value: {available: false, blocker: 'UNCHANGED'}}});
        this.onmessage({data: {id: message.id, value: null}});
      });
    }
  });
  const core = await owner.start();
  worker.onmessage({data: {kind: 'save-status', value: {available: true, blocker: null, revision: 'complete-native-save'}}});
  for (let i = 0; i < 100; i++) assert.equal(core.getCheckpointAvailability().revision, 'complete-native-save');
  assert.equal(calls.length, 1);
  const bytes = Uint8Array.of(7, 8);
  await core.acknowledgeCheckpoint(bytes);
  assert.equal(calls.at(-1).type, 'acknowledge'); assert.deepEqual(calls.at(-1).value, bytes);
  assert.equal(bytes.length, 2); assert.equal(core.getCheckpointAvailability().blocker, 'UNCHANGED');
  await core.stop();
  assert.equal(core.getCheckpointAvailability().blocker, 'NOT_READY');
  assert.equal(terminated, true); assert.equal(owner.children.length, 0);
});
