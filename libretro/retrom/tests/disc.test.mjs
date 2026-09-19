import {test} from 'node:test';
import assert from 'node:assert/strict';
import {discReader, mountDisc} from '../ppsspp-disc.mjs';
const B = 262144, source = {sha256: 'a'.repeat(64), sizeBytes: B * 10 + 3};
function transport() {
  const calls = []; let closed = false;
  const reader = {readInto(position, output, timeout) {
    if (closed) throw Error('CONTENT_IO_ABORTED');
    calls.push({position, length: output.length, timeout});
    for (let n = 0; n < output.length; n++) output[n] = Math.floor((position + n) / B) + 1;
    return output.length;
  }, close() {closed = true;}};
  return {calls, reader};
}
test('[BR-03] UNIT/ppsspp-disc preserves native offset, length, EOF and read-only virtual size', () => {
  const t = transport(), read = discReader(source, t.reader), bytes = new Uint8Array(10);
  assert.equal(read(bytes, 2, 6, B - 2), 6); assert.deepEqual([...bytes], [0, 0, 1, 1, 2, 2, 2, 2, 0, 0]);
  assert.equal(read(bytes, 0, 10, source.sizeBytes - 2), 2); assert.equal(bytes[0], 11);
  assert.equal(read(bytes, 0, 10, source.sizeBytes), 0); assert.throws(() => read(bytes, 0, 11, 0), /BOUNDS/);
  t.reader.close(); assert.throws(() => read(bytes, 0, 0, source.sizeBytes), /ABORTED/);
});
test('[X-30] UNIT/ppsspp-disc splits native reads larger than the public logical limit under one deadline', () => {
  const t = transport(), big = {...source, sizeBytes: 20 * 1024 * 1024};
  const output = new Uint8Array(17 * 1024 * 1024 + 19), read = discReader(big, t.reader);
  assert.equal(read(output, 0, output.length, 13), output.length);
  assert.equal(t.calls.length, Math.ceil(output.length / B));
  for (const call of t.calls) {assert.ok(call.length <= B); assert.ok(call.timeout <= 15000);}
  assert.equal(output.at(-1), Math.floor((13 + output.length - 1) / B) + 1);
});
test('virtual disc exposes full size and seeking while its backing allocation stays empty', () => {
  const t = transport(); let node;
  const FS = {createDataFile(_directory, _name, bytes, canRead, canWrite) {
    assert.equal(bytes.length, 0); assert.equal(canRead, true); assert.equal(canWrite, false);
    node = {node_ops: {getattr: () => ({mode: 0o100444, size: 0})}};
  }, lookupPath: path => {assert.equal(path, '/game/content.iso'); return {node};}, ErrnoError: class extends Error {}};
  assert.equal(mountDisc(FS, source, t.reader), '/game/content.iso'); assert.equal(node.node_ops.getattr(node).size, source.sizeBytes);
  assert.equal(node.stream_ops.llseek({position: 8}, -2, 1), 6);
  assert.equal(node.stream_ops.llseek({position: 0}, -3, 2), source.sizeBytes - 3);
  assert.throws(() => node.stream_ops.llseek({position: 0}, -1, 0)); assert.equal(t.calls.length, 1);
});
