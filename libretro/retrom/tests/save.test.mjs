import {test} from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {encodeSave, decodeSave, nativeSaves, saveRoot} from '../ppsspp-save.mjs';

const identity = 'a'.repeat(64), mac = '02:12:34:56:78:9a';
const save = (files = []) => ({identity, mac, files});
function filesystem() {
  const files = new Map(), directories = new Set([saveRoot]);
  let fd = 0, reads = 0;
  const FS = {
    mkdirTree(path) {for (let i = 1; i <= path.split('/').length; i++) directories.add(path.split('/').slice(0, i).join('/'));},
    readdir(path) {reads++; return ['.', '..', ...new Set([...files.keys(), ...directories].filter(p => p.startsWith(path + '/')).map(p => p.slice(path.length + 1).split('/')[0]))];},
    lstat(path) {return {mode: directories.has(path) ? 1 : 2, size: files.get(path)?.length ?? 0, mtime: new Date(1000)};},
    isDir: mode => mode === 1, isFile: mode => mode === 2,
    readFile: path => files.get(path).slice(),
    open(path, flags) {if (flags & 512 || !files.has(path)) files.set(path, new Uint8Array()); return {fd: ++fd, path, flags};},
    write(stream, bytes, offset, length) {files.set(stream.path, bytes.slice(offset, offset + length)); return length;},
    close(stream) {stream.fd = null;},
    writeFile(path, bytes) {const stream = FS.open(path, 1 | 512); FS.write(stream, bytes, 0, bytes.length); FS.close(stream);},
    unlink(path) {files.delete(path);},
    rename(from, to) {files.set(to, files.get(from)); files.delete(from);},
    truncate(path, length) {files.set(path, files.get(path).slice(0, length));},
  };
  return {FS, files, reads: () => reads};
}
test('native archive preserves complete multi-slot bytes and virtual identity without execution state', () => {
  const original = save([{path: 'SLOT1/PARAM.SFO', bytes: Uint8Array.of(1, 2), mtime: 1000},
    {path: 'SLOT2/DATA.BIN', bytes: Uint8Array.of(3, 4, 5), mtime: 2000}]);
  const bytes = encodeSave(original);
  assert.deepEqual(decodeSave(bytes, identity), original);
  assert.equal(bytes.length < 1024, true);
  assert.equal(new TextDecoder().decode(bytes).includes('stateSize'), false);
  assert.throws(() => decodeSave(bytes, 'b'.repeat(64)), /CHECKPOINT_INVALID/);
  assert.throws(() => decodeSave(bytes.slice(0, -1), identity), /CHECKPOINT_INVALID/);
});
test('archive rejects unsafe, conflicting and duplicate paths, invalid identity and sizes', () => {
  for (const paths of [['../escape'], ['/absolute'], ['SLOT/../bad'], ['SLOT/file', 'slot/FILE'], ['SLOT', 'SLOT/file']]) {
    assert.throws(() => encodeSave(save(paths.map(path => ({path, bytes: Uint8Array.of(1), mtime: 0})))), /CHECKPOINT_INVALID/);
  }
  assert.throws(() => encodeSave({...save(), mac: '00:00:00:00:00:00'}), /CHECKPOINT_INVALID/);
  assert.throws(() => encodeSave({...save(), identity: 'invalid'}), /CHECKPOINT_INVALID/);
  for (const header of [null, {}, {version: 1, identity, mac, files: [null]},
    {version: 1, identity, mac, files: [{path: 'file', size: -1, mtime: 0}]}]) {
    const json = new TextEncoder().encode(JSON.stringify(header)), bytes = new Uint8Array(4 + json.length);
    new DataView(bytes.buffer).setUint32(0, json.length, true); bytes.set(json, 4);
    assert.throws(() => decodeSave(bytes, identity), /CHECKPOINT_INVALID/);
  }
});
test('exports only completed native files, acknowledges exact content, and preserves later writes', async () => {
  const fs = filesystem(), statuses = [];
  let ready = true;
  const saves = await nativeSaves({FS: fs.FS, _psp_save_ready: () => Number(ready)},
    {identity, mac, publish: status => statuses.push(status), crypto: webcrypto});
  fs.FS.writeFile(saveRoot + '/.nomedia', Uint8Array.of(1));
  await saves.refresh(); assert.equal(statuses.at(-1).blocker, 'NO_SAVE');
  await assert.rejects(saves.checkpoint(), /SAVE_UNAVAILABLE/);
  fs.FS.mkdirTree(saveRoot + '/SLOT');
  ready = false; fs.FS.writeFile(saveRoot + '/SLOT/DATA.BIN', Uint8Array.of(7));
  await saves.refresh(); assert.equal(statuses.at(-1).blocker, 'BUSY');
  await assert.rejects(saves.checkpoint(), /SAVE_BUSY/);
  ready = true; await saves.refresh(); assert.equal(statuses.at(-1).available, true);
  const first = await saves.checkpoint(), revision = statuses.at(-1).revision;
  assert.equal(decodeSave(first, identity).files.length, 1);
  const reads = fs.reads(); await saves.refresh(); await saves.refresh(); assert.equal(fs.reads(), reads);
  fs.FS.writeFile(saveRoot + '/SLOT/DATA.BIN', Uint8Array.of(8)); await saves.refresh();
  await saves.acknowledge(first); assert.equal(statuses.at(-1).available, true);
  assert.notEqual(statuses.at(-1).revision, revision);
  const current = await saves.checkpoint(); await saves.acknowledge(current);
  assert.equal(statuses.at(-1).blocker, 'UNCHANGED');
  fs.FS.writeFile(saveRoot + '/SLOT/DATA.BIN', Uint8Array.of(8)); await saves.refresh();
  assert.equal(statuses.at(-1).blocker, 'UNCHANGED');
  fs.FS.unlink(saveRoot + '/SLOT/DATA.BIN'); await saves.refresh();
  const deleted = await saves.checkpoint(); assert.equal(decodeSave(deleted, identity).files.length, 0);
  const restoredFS = filesystem(), restoredStatuses = [];
  const restored = await nativeSaves({FS: restoredFS.FS, _psp_save_ready: () => 1},
    {identity, mac, restore: decodeSave(deleted, identity), publish: s => restoredStatuses.push(s), crypto: webcrypto});
  await restored.refresh(); assert.equal(restoredStatuses.at(-1).blocker, 'UNCHANGED');
});
test('checks declared file size against the aggregate limit before reading file contents', async () => {
  const fs = filesystem();
  fs.FS.mkdirTree(saveRoot + '/SLOT'); fs.FS.writeFile(saveRoot + '/SLOT/DATA.BIN', Uint8Array.of(1));
  const stat = fs.FS.lstat;
  let read = false;
  fs.FS.lstat = path => path.endsWith('DATA.BIN') ? {...stat(path), size: 256 * 1024 * 1024 + 1} : stat(path);
  fs.FS.readFile = () => {read = true; throw new Error('oversized allocation');};
  const saves = await nativeSaves({FS: fs.FS, _psp_save_ready: () => 1}, {identity, mac, publish() {}, crypto: webcrypto});
  await assert.rejects(saves.refresh(), /CHECKPOINT_INVALID/);
  assert.equal(read, false);
});
test('native IO is busy before its first file mutation and clears without a false revision', async () => {
  const fs = filesystem(), statuses = [];
  let ready = true;
  const saves = await nativeSaves({FS: fs.FS, _psp_save_ready: () => Number(ready)},
    {identity, mac, publish: status => statuses.push(status), crypto: webcrypto});
  await saves.refresh(); assert.equal(statuses.at(-1).blocker, 'NO_SAVE');
  const reads = fs.reads();
  ready = false; await saves.refresh(); assert.equal(statuses.at(-1).blocker, 'BUSY');
  ready = true; await saves.refresh(); assert.equal(statuses.at(-1).blocker, 'NO_SAVE');
  assert.equal(fs.reads(), reads);
  fs.FS.mkdirTree(saveRoot + '/SLOT'); fs.FS.writeFile(saveRoot + '/SLOT/DATA.BIN', Uint8Array.of(7));
  await saves.refresh(); const checkpoint = await saves.checkpoint();
  await saves.acknowledge(checkpoint);
  ready = false; await saves.refresh(); assert.equal(statuses.at(-1).blocker, 'BUSY');
  ready = true; await saves.refresh(); assert.equal(statuses.at(-1).blocker, 'UNCHANGED');
});
test('writable handles block partial direct sceIo saves and restore begins at an acknowledged baseline', async () => {
  const fs = filesystem(), statuses = [];
  const original = save([{path: 'SLOT/DATA.BIN', bytes: Uint8Array.of(9), mtime: 1000}]);
  fs.FS.mkdirTree(saveRoot + '/SLOT'); fs.FS.writeFile(saveRoot + '/SLOT/DATA.BIN', Uint8Array.of(9));
  const saves = await nativeSaves({FS: fs.FS, _psp_save_ready: () => 1},
    {identity, mac, restore: original, publish: s => statuses.push(s), crypto: webcrypto});
  await saves.refresh(); assert.equal(statuses.at(-1).blocker, 'UNCHANGED');
  const stream = fs.FS.open(saveRoot + '/SLOT/DATA.BIN', 1 | 512);
  fs.FS.write(stream, Uint8Array.of(3), 0, 1);
  await saves.refresh(); assert.equal(statuses.at(-1).blocker, 'BUSY');
  fs.FS.close(stream); await saves.refresh(); assert.equal(statuses.at(-1).available, true);
});
