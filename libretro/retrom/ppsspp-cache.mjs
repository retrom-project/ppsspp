import {boundedBytes} from './ppsspp-range.mjs';

const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  value => value.toString(16).padStart(2, '0')).join('');

export function persistentCache(storage = globalThis.caches, origin = new URL(import.meta.url).origin) {
  const url = key => new URL(`/__retrom_ppsspp_blocks__/${key}`, origin);
  return {
    async get(key, size) {
      const cache = await storage.open('retrom-ppsspp-blocks-v1');
      const response = await cache.match(url(key));
      if (!response) return null;
      const bytes = await boundedBytes(response, size);
      // This detects damaged local cache entries; source authenticity comes from the immutable server content.
      if (response.headers.get('X-Block-SHA256') !== await digest(bytes)) return null;
      return bytes;
    },
    async put(key, bytes) {
      const cache = await storage.open('retrom-ppsspp-blocks-v1');
      await cache.put(url(key), new Response(bytes, {headers: {'X-Block-SHA256': await digest(bytes)}}));
    },
  };
}
