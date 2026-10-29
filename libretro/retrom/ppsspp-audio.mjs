export function createAudio(win) {
  const context = new win.AudioContext({sampleRate: 44100});
  const gain = context.createGain(); gain.connect(context.destination);
  const playing = new Set();
  const delay = 0.1;
  let next = 0, paused = false;
  const clear = () => {for (const source of playing) source.stop(); playing.clear(); next = 0;};
  const unlock = () => {if (!paused) void context.resume();};
  win.addEventListener('pointerdown', unlock); win.addEventListener('keydown', unlock);
  return {
    push(samples) {
      if (paused || context.state !== 'running' || samples.length < 2) return;
      // Buffer scheduling jitter once at startup/underrun. Adding a minimum lead
      // to every packet inserts small silences even while the old buffer plays.
      if (next <= context.currentTime) next = context.currentTime + delay;
      if (next > context.currentTime + 0.5) return;
      const frames = samples.length / 2, buffer = context.createBuffer(2, frames, 44100);
      for (let channel = 0; channel < 2; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < frames; i++) data[i] = samples[i * 2 + channel] / 32768;
      }
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(gain);
      // The emulator and audio device have independent clocks. Correct gradual
      // drift without periodically cutting off the entire playing queue.
      const rate = 1 + Math.max(-0.02, Math.min(0.02, (next - context.currentTime - delay) * 0.1));
      source.playbackRate.value = rate;
      source.onended = () => {playing.delete(source); source.disconnect();};
      playing.add(source); source.start(next); next += frames / 44100 / rate;
    },
    volume(value) {gain.gain.value = Math.max(0, Math.min(1, value));},
    async pause(value) {paused = value; clear(); if (paused) await context.suspend(); else await context.resume();},
    async stop() {paused = true; clear(); win.removeEventListener('pointerdown', unlock); win.removeEventListener('keydown', unlock); await context.close();},
  };
}
