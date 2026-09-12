const padIds = [0, 8, 1, 9, 10, 11, null, null, 2, 3, null, null, 4, 5, 6, 7];
const keys = {ArrowUp: 4, ArrowDown: 5, ArrowLeft: 6, ArrowRight: 7, KeyX: 0, KeyZ: 8, KeyS: 1, KeyA: 9, KeyQ: 10, KeyW: 11, Enter: 3, ShiftRight: 2};
export function mapPad(pad) {
  let mask = 0;
  padIds.forEach((id, index) => {if (id !== null && pad?.buttons[index]?.pressed) mask |= 1 << id;});
  const axis = value => Math.abs(value || 0) < 0.15 ? 0 : Math.round(Math.max(-1, Math.min(1, value)) * 32767);
  return {mask, x: axis(pad?.axes[0]), y: axis(pad?.axes[1])};
}
export function installInput(win, send) {
  let keyboard = 0, paused = false, stopped = false, request;
  const release = () => {keyboard = 0; send({mask: 0, x: 0, y: 0});};
  const key = event => {
    const id = keys[event.code];
    if (id === undefined || paused) return;
    event.preventDefault();
    keyboard = event.type === 'keydown' ? keyboard | (1 << id) : keyboard & ~(1 << id);
  };
  const poll = () => {
    if (stopped) return;
    if (!paused) {
      const pad = [...win.navigator.getGamepads()].find(p => p?.connected && p.mapping === 'standard');
      const state = mapPad(pad); send({...state, mask: state.mask | keyboard});
    }
    request = win.requestAnimationFrame(poll);
  };
  win.addEventListener('keydown', key); win.addEventListener('keyup', key); win.addEventListener('blur', release); poll();
  return {
    pause(value) {paused = value; release();},
    stop() {stopped = true; win.cancelAnimationFrame(request); release(); win.removeEventListener('keydown', key); win.removeEventListener('keyup', key); win.removeEventListener('blur', release);},
  };
}
