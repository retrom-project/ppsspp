import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discReader, mountDisc, createDiscIO} from '../ppsspp-disc.mjs';
import {blockSize} from '../ppsspp-range.mjs';

const source = {kind: 'SEEKABLE_BLOB', rangeRequired: true, url: 'https://retrom.test/disc.iso', sha256: 'a'.repeat(64), sizeBytes: blockSize * 10 + 3};
function transport() {
  const buffer = new SharedArrayBuffer(blockSize + 16), control = new Int32Array(buffer, 0, 4), calls = [];
  const port = {postMessage(index) {
    calls.push(index); const length = Math.min(blockSize, source.sizeBytes - index * blockSize);
    new Uint8Array(buffer, 16).fill(index + 1); control[1] = length; control[0] = 1;
  }};
  return {buffer, control, port, calls};
}
test('synchronous random reads cross block boundaries, reuse hot blocks and handle EOF', () => {
  const t = transport(), read = discReader(source, t.buffer, t.port), bytes = new Uint8Array(10);
  assert.equal(read(bytes, 2, 6, blockSize - 2), 6); assert.deepEqual([...bytes], [0, 0, 1, 1, 2, 2, 2, 2, 0, 0]);
  read(bytes, 0, 4, blockSize - 2); assert.deepEqual(t.calls, [0, 1]);
  assert.equal(read(bytes, 0, 10, source.sizeBytes - 2), 2); assert.equal(bytes[0], 11);
  assert.equal(read(bytes, 0, 10, source.sizeBytes), 0);
  assert.throws(() => read(bytes, 0, 11, 0), /BOUNDS/);
});
test('a timed out or closed IO bridge cannot return stale bytes', () => {
  const t = transport(), read = discReader(source, t.buffer, {postMessage() {}}, () => 'timed-out');
  assert.throws(() => read(new Uint8Array(1), 0, 1, 0), /TIMEOUT/); assert.equal(t.control[2], 1);
  assert.throws(() => read(new Uint8Array(1), 0, 1, 0), /CLOSED/);
});
test('virtual disc exposes full size and seeking while its backing allocation stays empty', () => {
  const t = transport(); let node;
  const FS = {createDataFile(_directory, _name, bytes, canRead, canWrite) {
    assert.equal(bytes.length, 0); assert.equal(canRead, true); assert.equal(canWrite, false);
    node = {node_ops: {getattr: () => ({mode: 0o100444, size: 0})}};
  }, lookupPath: path => {assert.equal(path, '/game/content.iso'); return {node};}, ErrnoError: class extends Error {}};
  assert.equal(mountDisc(FS, source, t.buffer, t.port), '/game/content.iso');
  assert.equal(node.node_ops.getattr(node).size, source.sizeBytes);
  assert.equal(node.stream_ops.llseek({position: 8}, -2, 1), 6);
  assert.equal(node.stream_ops.llseek({position: 0}, -3, 2), source.sizeBytes - 3);
  assert.throws(() => node.stream_ops.llseek({position: 0}, -1, 0));
  assert.deepEqual(t.calls, [0]);
});
test('closing IO wakes a waiting emulator and terminates the network worker', () => {
  let terminated = 0, closed = 0;
  const win = {SharedArrayBuffer, MessageChannel: class {constructor() {this.port1 = this.port2 = {close() {closed++;}};}},
    Worker: class {postMessage() {} terminate() {terminated++;}}};
  const io = createDiscIO(win, source, () => {}), control = new Int32Array(io.buffer, 0, 4);
  io.close(); assert.equal(control[2], 1); assert.equal(control[0], -1); assert.equal(terminated, 1); assert.equal(closed, 2);
});
