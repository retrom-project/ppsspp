import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {contentAbi, contractSha256, validateContent, loadContentReader} from '../ppsspp-content.mjs';
const source = {sha256: 'a'.repeat(64), sizeBytes: 17};
const content = {abi: contentAbi, contractSha256, sizeBytes: 17, objectKey: 'b'.repeat(64),
  syncClientUrl: 'blob:https://core.test/verified', buffer: new SharedArrayBuffer(262208), port: {postMessage() {}}};
test('[BR-12] UNIT/ppsspp-contract mirrors the exact closed runtime contract and fixed error numbers', async () => {
  const root = new URL('../content-io-v1/', import.meta.url), paths = (await readdir(root)).sort();
  assert.deepEqual(paths, ['CONTRACT.sha256', 'content-io.d.ts', 'errors.json', 'protocol.schema.json', 'vectors.json']);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex'); let listing = '';
  for (const path of paths.filter(path => path !== 'CONTRACT.sha256')) listing += `${path}\n${sha(await readFile(new URL(path, root)))}\n`;
  assert.equal(sha(listing), contractSha256); assert.equal((await readFile(new URL('CONTRACT.sha256', root), 'utf8')).trim(), contractSha256);
});
test('[BR-12] UNIT/ppsspp-contract rejects old clients, URLs in source and unverified asset URLs', async () => {
  assert.doesNotThrow(() => validateContent(source, content));
  assert.throws(() => validateContent({...source, url: 'https://game.test/'}, content), /ABI_MISMATCH/);
  assert.throws(() => validateContent(source, {...content, syncClientUrl: 'https://core.test/client'}), /ABI_MISMATCH/);
  for (const module of [{abi: contentAbi, contractSha256: '0'.repeat(64)}, {abi: 'old', contractSha256}]) {
    await assert.rejects(loadContentReader(source, content, async () => module), /ABI_MISMATCH/);
  }
  const reader = {}, module = {abi: contentAbi, contractSha256, createSyncContentReader: options => {
    assert.equal(options.buffer, content.buffer); assert.equal(options.sizeBytes, 17); assert.equal(options.syncClientUrl, undefined); return reader;
  }};
  assert.equal(await loadContentReader(source, content, async () => module), reader);
});
