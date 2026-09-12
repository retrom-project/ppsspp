import {installInput} from './ppsspp-input.mjs';
import {createAudio} from './ppsspp-audio.mjs';
import {createDiscIO} from './ppsspp-disc.mjs';

export const abi = 'ppsspp-host-v2';
export async function createPPSSPPHost({target, source, restore, onFailure, signal}) {
  signal?.throwIfAborted();
  const win = target.ownerDocument.defaultView;
  const canvas = target.ownerDocument.createElement('canvas'); canvas.width = 480; canvas.height = 272; canvas.id = 'canvas'; canvas.tabIndex = 0;
  target.append(canvas);
  let worker, audio;
  try {
    worker = new win.Worker(new URL('./ppsspp.worker.mjs', import.meta.url), {type: 'module'});
    audio = createAudio(win);
  } catch (error) {worker?.terminate(); canvas.remove(); throw error;}
  const pending = new Map();
  let sequence = 0, stopped = false, frames = 0;
  const rejectAll = error => {for (const item of pending.values()) {win.clearTimeout(item.timer); item.reject(error);} pending.clear();};
  const fatal = error => {rejectAll(error); if (!stopped) {onFailure(error); void stop();}};
  worker.onerror = () => fatal(new Error('PPSSPP_WORKER_FAILED'));
  worker.onmessage = ({data}) => {
    if (data.kind === 'audio') {audio.push(data.samples); return;}
    if (data.kind === 'frames') {frames = data.value; return;}
    if (data.kind === 'diagnostic') {console.warn('PPSSPP:', data.message); return;}
    if (data.id === 0 && data.error) {fatal(new Error(data.error)); return;}
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id); win.clearTimeout(item.timer);
    data.error ? item.reject(new Error(data.error)) : item.resolve(data.value);
  };
  function call(type, value, transfers = []) {
    if (stopped) return Promise.reject(new Error('PPSSPP_RUNTIME_EXITED'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = win.setTimeout(() => {pending.delete(id); reject(new Error('PPSSPP_OPERATION_TIMEOUT'));}, type === 'start' ? 90000 : 15000);
      pending.set(id, {resolve, reject, timer}); worker.postMessage({id, type, value}, transfers);
    });
  }
  let input, disc;
  async function stop() {
    if (stopped) return;
    input?.stop(); disc?.close(); signal?.removeEventListener('abort', abort);
    const stopping = call('stop'); stopped = true;
    try {await stopping;} catch {} finally {worker.terminate(); rejectAll(new Error('PPSSPP_RUNTIME_EXITED')); canvas.remove(); await audio.stop();}
  }
  const abort = () => {void stop();};
  try {
    signal?.throwIfAborted(); signal?.addEventListener('abort', abort, {once: true});
    disc = createDiscIO(win, source, fatal);
    const surface = canvas.transferControlToOffscreen();
    await call('start', {canvas: surface, source, buffer: disc.buffer, port: disc.port, restore}, [surface, disc.port]);
    signal?.throwIfAborted();
    input = installInput(win, value => {if (!stopped) worker.postMessage({id: -1, type: 'input', value});});
    canvas.focus();
  } catch (error) {await stop(); throw error;}
  return {
    canvas, frameCount: () => frames, stop,
    checkpoint: () => call('checkpoint'), screenshot: () => call('screenshot'),
    async pause() {input.pause(true); await call('pause'); await audio.pause(true);},
    async resume() {await audio.pause(false); await call('resume'); input.pause(false);},
    setVolume: value => audio.volume(value),
  };
}
globalThis.__RETROM_PPSSPP_V1__ = {abi, createPPSSPPHost};
