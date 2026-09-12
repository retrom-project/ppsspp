import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAudio} from '../ppsspp-audio.mjs';
test('empty audio batches are ignored; stereo samples, pause and stop retain their lifecycle', async () => {
  const buffers = [], listeners = new Set(); let stopped = 0, closed = false;
  const win = {addEventListener: name => listeners.add(name), removeEventListener: name => listeners.delete(name),
    AudioContext: class {
      state = 'running'; currentTime = 0; destination = {};
      createGain() {return {connect() {}, gain: {value: 1}};}
      createBuffer(channels, frames) {
        assert.ok(frames > 0);
        const values = Array.from({length: channels}, () => new Float32Array(frames)); buffers.push(values);
        return {getChannelData: channel => values[channel]};
      }
      createBufferSource() {return {connect() {}, disconnect() {}, start() {}, stop() {stopped++;}};}
      async suspend() {this.state = 'suspended';} async resume() {this.state = 'running';}
      async close() {closed = true;}
    }};
  const audio = createAudio(win);
  audio.push(new Int16Array()); assert.equal(buffers.length, 0);
  audio.push(new Int16Array([16384, -16384])); assert.deepEqual(buffers[0].map(x => x[0]), [0.5, -0.5]);
  await audio.pause(true); audio.push(new Int16Array([1, 1])); assert.equal(buffers.length, 1);
  await audio.stop(); assert.equal(stopped, 1); assert.equal(closed, true); assert.equal(listeners.size, 0);
});
