import { sourcePoint } from '../../tools/dhamri/viewer/geometry.mjs';

const KEYS = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Arrow(Up|Down|Left|Right)|Enter|Escape|Backspace|Tab|Space|Delete|Insert|Home|End|PageUp|PageDown|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Meta(Left|Right)|CapsLock|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash)$/;

export function bindRemoteInput(video, client) {
  const removals = [];
  const on = (target, name, handler, options) => { target.addEventListener(name, handler, options); removals.push(() => target.removeEventListener(name, handler, options)); };
  const active = () => client.get().phase === 'active';
  const stop = () => { if (active() || client.get().phase === 'pending') client.stop('context'); };
  const point = event => sourcePoint(video.getBoundingClientRect(), video.videoWidth, video.videoHeight, client.get().display, event.clientX, event.clientY);
  let lastMove = 0, wasFullscreen = Boolean(document.fullscreenElement);
  on(video, 'pointermove', event => {
    if (!active() || performance.now() - lastMove < 16) return;
    const p = point(event);
    if (p) { lastMove = performance.now(); client.input({ kind: 'move', ...p }); }
  });
  on(video, 'pointerdown', event => {
    const p = point(event);
    if (!active() || !p || event.button > 2) return;
    event.preventDefault(); video.focus({ preventScroll: true }); video.setPointerCapture(event.pointerId);
    client.input({ kind: 'button', button: event.button, down: true, ...p });
  });
  on(video, 'pointerup', event => {
    if (!active()) return;
    event.preventDefault(); const p = point(event);
    client.input(p ? { kind: 'button', button: event.button, down: false, ...p } : { kind: 'reset' });
  });
  const release = () => { if (active()) client.input({ kind: 'reset' }); };
  on(video, 'pointercancel', release); on(video, 'lostpointercapture', release); on(video, 'blur', release);
  on(video, 'contextmenu', event => { if (active()) event.preventDefault(); });
  on(video, 'dblclick', event => { if (active()) { event.preventDefault(); event.stopPropagation(); } });
  on(video, 'wheel', event => {
    if (!active()) return;
    event.preventDefault(); if (event.deltaY) client.input({ kind: 'wheel', delta: -Math.sign(event.deltaY) * 120 });
  }, { passive: false });
  for (const type of ['keydown', 'keyup']) on(video, type, event => {
    if (!active()) return;
    // Prevent player shortcuts (F, K, M...) and browser actions from also firing.
    event.preventDefault(); event.stopPropagation();
    if (KEYS.test(event.code)) client.input({ kind: 'key', code: event.code, down: type === 'keydown' });
  });
  on(window, 'keydown', event => {
    if (event.code === 'Escape' && (active() || client.get().phase === 'pending')) { event.preventDefault(); event.stopPropagation(); client.stop(); }
  }, true);
  on(window, 'blur', stop); on(window, 'pagehide', stop);
  on(document, 'visibilitychange', () => { if (document.hidden) stop(); });
  on(document, 'fullscreenchange', () => { if (wasFullscreen && !document.fullscreenElement) stop(); wasFullscreen = Boolean(document.fullscreenElement); });
  for (const event of ['pause', 'ended', 'emptied', 'enterpictureinpicture']) on(video, event, stop);
  return () => { stop(); removals.forEach(remove => remove()); };
}
