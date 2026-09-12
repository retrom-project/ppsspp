import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RangeReader, blockSize, validateSource} from '../ppsspp-range.mjs';
import {persistentCache} from '../ppsspp-cache.mjs';

const source = {kind: 'SEEKABLE_BLOB', rangeRequired: true, url: 'https://retrom.test/disc.iso', sha256: 'a'.repeat(64), sizeBytes: blockSize * 40 + 3};
function server(record = []) {
  return async (url, options) => {
    const [, first, last] = options.headers.Range.match(/^bytes=(\d+)-(\d+)$/);
    const start = Number(first), end = Number(last); record.push({url, ...options});
    return new Response(new Uint8Array(end - start + 1).fill(start / blockSize + 1), {status: 206, headers: {
      'Content-Range': `bytes ${start}-${end}/${source.sizeBytes}`, 'Content-Length': String(end - start + 1),
      ETag: `"sha256-${source.sha256}"`,
    }});
  };
}
function storage() {
  const entries = new Map();
  return {entries, open: async () => ({match: async url => entries.get(String(url))?.clone(),
    put: async (url, response) => {entries.set(String(url), response.clone());}})};
}
test('the default browser fetch retains its WorkerGlobalScope receiver', async t => {
  const respond = server();
  t.mock.method(globalThis, 'fetch', function (...args) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    return respond(...args);
  });
  const reader = new RangeReader(source);
  assert.equal((await reader.block(0)).length, blockSize); reader.close();
});
test('only requested blocks are fetched, coalesced and reused across instances with changed launch URLs', async () => {
  const record = [], saved = storage(), cache = persistentCache(saved, 'https://retrom.test');
  const first = new RangeReader(source, {fetcher: server(record), cache});
  const [a, b] = await Promise.all([first.block(0), first.block(0)]);
  assert.equal(record.length, 1); assert.deepEqual(a, b); assert.equal(a.length, blockSize);
  assert.equal((await first.block(40)).length, 3); first.close();
  const second = new RangeReader({...source, url: source.url + '?session=2'}, {fetcher: server(record), cache});
  assert.deepEqual(await second.block(0), a); assert.equal((await second.block(40)).length, 3);
  assert.equal(record.length, 2); assert.equal(record[0].headers['If-Match'], `"sha256-${source.sha256}"`);
  assert.equal(record[0].credentials, 'same-origin'); assert.equal(record[0].redirect, 'error'); second.close();
});
test('persistent cache corruption and quota/unavailable storage fall back to bounded reads', async () => {
  const saved = storage(), cache = persistentCache(saved, 'https://retrom.test'), record = [];
  await new RangeReader(source, {fetcher: server(record), cache}).block(0);
  const key = saved.entries.keys().next().value;
  saved.entries.set(key, new Response(new Uint8Array(blockSize), {headers: {'X-Block-SHA256': '0'.repeat(64)}}));
  assert.equal((await new RangeReader(source, {fetcher: server(record), cache}).block(0))[0], 1);
  assert.equal(record.length, 2);
  const unavailable = {get: async () => {throw Error('unavailable');}, put: async () => {throw Error('quota');}};
  assert.equal((await new RangeReader(source, {fetcher: server(record), cache: unavailable}).block(0))[0], 1);
  assert.equal(record.length, 3);
});
test('wrong status, range, ETag, length, truncated or oversized bodies never enter cache', async () => {
  const valid = await server()(source.url, {headers: {Range: `bytes=0-${blockSize - 1}`}});
  const headers = Object.fromEntries(valid.headers);
  const bad = [
    new Response('entire disc', {status: 200}),
    new Response('unauthorized', {status: 401}),
    new Response('changed', {status: 412}),
    ...['content-range', 'etag', 'content-length'].map(name => new Response(new Uint8Array(blockSize), {status: 206, headers: {...headers, [name]: 'bad'}})),
    new Response(new Uint8Array(blockSize - 1), {status: 206, headers}),
    new Response(new Uint8Array(blockSize + 1), {status: 206, headers}),
  ];
  for (const response of bad) {
    let stored = false;
    const reader = new RangeReader(source, {fetcher: async () => response, cache: {put: async () => {stored = true;}}});
    await assert.rejects(reader.block(0), /PPSSPP_DISC_RANGE_INVALID/); assert.equal(stored, false); reader.close();
  }
});
test('memory stays bounded and invalid offsets are rejected without network requests', async () => {
  const record = [], reader = new RangeReader(source, {fetcher: server(record)});
  for (let i = 0; i < 40; i++) await reader.block(i);
  assert.equal(reader.memory.size, 32);
  for (const index of [-1, 41, NaN, 0.5]) await assert.rejects(reader.block(index), /PPSSPP_DISC_BOUNDS/);
  assert.equal(record.length, 40); reader.close();
  await assert.rejects(reader.block(0), /PPSSPP_DISC_CLOSED/);
  for (const value of [{...source, rangeRequired: false}, {...source, sizeBytes: 2147483648}, {...source, sha256: ''}]) {
    assert.throws(() => validateSource(value), /PPSSPP_DISC_SOURCE_INVALID/);
  }
});
test('exit aborts an in-flight request and never publishes its bytes', async () => {
  let requested;
  const fetching = new Promise(resolve => {requested = resolve;});
  const reader = new RangeReader(source, {fetcher: (_url, {signal}) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), {once: true}); requested();
  })});
  const result = reader.block(0); await fetching; reader.close();
  await assert.rejects(result, /PPSSPP_DISC_CLOSED/); assert.equal(reader.memory.size, 0);
});
