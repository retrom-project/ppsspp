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
      createBufferSource() {return {playbackRate: {value: 1}, connect() {}, disconnect() {}, start() {}, stop() {stopped++;}};}
      async suspend() {this.state = 'suspended';} async resume() {this.state = 'running';}
      async close() {closed = true;}
    }};
  const audio = createAudio(win);
  audio.push(new Int16Array()); assert.equal(buffers.length, 0);
  audio.push(new Int16Array([16384, -16384])); assert.deepEqual(buffers[0].map(x => x[0]), [0.5, -0.5]);
  await audio.pause(true); audio.push(new Int16Array([1, 1])); assert.equal(buffers.length, 1);
  await audio.stop(); assert.equal(stopped, 1); assert.equal(closed, true); assert.equal(listeners.size, 0);
});

function audioClock() {
  const starts = []; let context, stops = 0;
  const win = {addEventListener() {}, removeEventListener() {}, AudioContext: class {
    state = 'running'; currentTime = 0; destination = {};
    constructor() {context = this;}
    createGain() {return {connect() {}, gain: {value: 1}};}
    createBuffer(channels, frames, rate) {
      const data = Array.from({length: channels}, () => new Float32Array(frames));
      return {duration: frames / rate, getChannelData: channel => data[channel]};
    }
    createBufferSource() {
      const source = {playbackRate: {value: 1}, connect() {}, disconnect() {},
        start(at) {starts.push({at, end: at + source.buffer.duration / source.playbackRate.value});},
        stop() {stops++;}};
      return source;
    }
    async close() {}
  }};
  return {audio: createAudio(win), starts, stops: () => stops,
    advance: time => {context.currentTime = Math.max(context.currentTime, time);}};
}
test('packet jitter preserves contiguous PCM instead of inserting silence before each late batch', async () => {
  const clock = audioClock(), samples = new Int16Array(735 * 2);
  for (let i = 0; i < 180; i++) {
    clock.advance(i * 735 / 44100 + (i % 10 === 5 ? .025 : 0));
    clock.audio.push(samples);
  }
  for (let i = 1; i < clock.starts.length; i++) {
    assert.ok(Math.abs(clock.starts[i].at - clock.starts[i - 1].end) < 1e-9, 'PCM packets meet without a gap or overlap');
  }
  await clock.audio.stop();
});
test('small producer clock drift does not periodically stop queued audio', async () => {
  const clock = audioClock(), samples = new Int16Array(735 * 2);
  for (let i = 0; i < 3600; i++) {clock.advance(i / 60.3); clock.audio.push(samples);}
  assert.equal(clock.stops(), 0, 'normal clock drift never discards the playing queue');
  assert.ok(clock.starts.at(-1).end - 3600 / 60.3 < .3, 'latency stays bounded');
  await clock.audio.stop();
});
