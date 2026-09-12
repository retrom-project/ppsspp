export function createAudio(win) {
  const context = new win.AudioContext({sampleRate: 44100});
  const gain = context.createGain(); gain.connect(context.destination);
  const playing = new Set();
  let next = 0, paused = false;
  const clear = () => {for (const source of playing) source.stop(); playing.clear(); next = 0;};
  const unlock = () => {if (!paused) void context.resume();};
  win.addEventListener('pointerdown', unlock); win.addEventListener('keydown', unlock);
  return {
    push(samples) {
      if (paused || context.state !== 'running' || samples.length < 2) return;
      if (next > context.currentTime + 0.2) {clear();}
      const frames = samples.length / 2, buffer = context.createBuffer(2, frames, 44100);
      for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < frames; i++) data[i] = samples[i * 2 + channel] / 32768;
      }
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(gain);
      source.onended = () => {playing.delete(source); source.disconnect();};
      next = Math.max(next, context.currentTime + 0.02); playing.add(source); source.start(next); next += frames / 44100;
    },
    volume(value) {gain.gain.value = Math.max(0, Math.min(1, value));},
    async pause(value) {paused = value; clear(); if (paused) await context.suspend(); else await context.resume();},
    async stop() {paused = true; clear(); win.removeEventListener('pointerdown', unlock); win.removeEventListener('keydown', unlock); await context.close();},
  };
}
