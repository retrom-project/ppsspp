import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mapPad, installInput} from '../ppsspp-input.mjs';
test('standard buttons produce exactly one PSP input and axes are bounded', () => {
  for (const [index, id] of [[0, 0], [1, 8], [2, 1], [3, 9], [4, 10], [5, 11], [8, 2], [9, 3], [12, 4], [13, 5], [14, 6], [15, 7]]) {
    const buttons = Array.from({length: 17}, (_, i) => ({pressed: i === index}));
    assert.equal(mapPad({buttons, axes: [0, 0]}).mask, 1 << id);
  }
  assert.deepEqual(mapPad({buttons: [], axes: [-2, 0.1]}), {mask: 0, x: -32767, y: 0});
});
test('pause, disconnect and stop release keys and remove listeners', () => {
  const listeners = new Map(), values = [];
  let poll, pad = {connected: true, mapping: 'standard', buttons: [{pressed: true}], axes: [0, 0]};
  const win = {navigator: {getGamepads: () => [pad]}, requestAnimationFrame: fn => {poll = fn; return 1;}, cancelAnimationFrame: () => {},
    addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key)};
  const input = installInput(win, value => values.push(value));
  assert.equal(values.at(-1).mask, 1 << 0);
  pad = null; poll(); assert.equal(values.at(-1).mask, 0);
  listeners.get('keydown')({code: 'ArrowUp', type: 'keydown', preventDefault() {}}); poll();
  assert.equal(values.at(-1).mask, 1 << 4);
  input.pause(true); assert.equal(values.at(-1).mask, 0);
  input.pause(false); poll(); assert.equal(values.at(-1).mask, 0);
  input.stop(); assert.equal(listeners.size, 0); assert.equal(values.at(-1).mask, 0);
});
