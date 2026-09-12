import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

async function host(createAudio, Worker) {
  const context = vm.createContext({URL});
  const source = await readFile(new URL('../ppsspp-host.mjs', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source, {context, initializeImportMeta: meta => {meta.url = 'https://core.test/ppsspp-host.mjs';}});
  await module.link(specifier => new vm.SyntheticModule([specifier.includes('input') ? 'installInput' : 'createAudio'], function () {
    this.setExport(specifier.includes('input') ? 'installInput' : 'createAudio', specifier.includes('input') ? () => ({}) : createAudio);
  }, {context}));
  await module.evaluate();
  const children = [], canvas = {remove() {children.splice(children.indexOf(canvas), 1);}};
  const target = {append: value => children.push(value), ownerDocument: {defaultView: {Worker}, createElement: () => canvas}};
  return {children, start: () => module.namespace.createPPSSPPHost({target})};
}
test('failed worker/audio construction releases the canvas and any created worker', async () => {
  const unavailable = await host(() => ({}), class {constructor() {throw Error('Worker unavailable');}});
  await assert.rejects(unavailable.start(), /Worker unavailable/); assert.equal(unavailable.children.length, 0);
  let terminated = false;
  const unsupported = await host(() => {throw Error('Audio unavailable');}, class {terminate() {terminated = true;}});
  await assert.rejects(unsupported.start(), /Audio unavailable/); assert.equal(unsupported.children.length, 0); assert.equal(terminated, true);
});
