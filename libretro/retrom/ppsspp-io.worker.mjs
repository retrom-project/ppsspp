import {RangeReader} from './ppsspp-range.mjs';
import {persistentCache} from './ppsspp-cache.mjs';

self.onmessage = ({data: {source, buffer, port}}) => {
  const control = new Int32Array(buffer, 0, 4), data = new Uint8Array(buffer, 16);
  const reader = new RangeReader(source, {cache: persistentCache()});
  port.onmessage = async ({data: index}) => {
    try {
      const bytes = await reader.block(index);
      if (Atomics.load(control, 2)) return;
      data.set(bytes); Atomics.store(control, 1, bytes.length);
      Atomics.store(control, 0, 1); Atomics.notify(control, 0);
    } catch (error) {
      Atomics.store(control, 2, 1); Atomics.store(control, 0, -1); Atomics.notify(control, 0);
      reader.close(); postMessage({error: error.message || 'PPSSPP_DISC_READ_FAILED'});
    }
  };
};
