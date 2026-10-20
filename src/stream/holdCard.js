// The "be right back" picture sent while a broadcast is on hold. It travels
// inside the video, so every viewer sees it, including players that know
// nothing about hold. It redraws once a second (the clock), which also gives
// a viewer who joins mid-hold a fresh frame instead of black.
import { formatElapsed } from './hold.js';

const FONT = "'Readex Pro', system-ui, -apple-system, 'Segoe UI', Tahoma, sans-serif";
// A still card needs no 4K canvas.
const MAX_W = 1920;
const MAX_H = 1080;

export function createHoldCard({ width = 1280, height = 720, note = '', room = '', since = Date.now() } = {}) {
  const scale = Math.min(1, MAX_W / width, MAX_H / height);
  const w = Math.round((width * scale) / 2) * 2;
  const h = Math.round((height * scale) / 2) * 2;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  let text = note;

  const draw = () => {
    const glow = ctx.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, Math.max(w, h) * 0.6);
    glow.addColorStop(0, '#13265c');
    glow.addColorStop(1, '#03050a');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // Pause mark in a rounded tile.
    const tile = h * 0.16;
    const tx = (w - tile) / 2;
    const ty = h * 0.18;
    ctx.fillStyle = 'rgb(30 58 138 / 0.55)';
    ctx.strokeStyle = 'rgb(142 168 255 / 0.5)';
    ctx.lineWidth = Math.max(2, h * 0.003);
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(tx, ty, tile, tile, tile * 0.24);
    else ctx.rect(tx, ty, tile, tile);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f4f6fb';
    const bar = tile * 0.14;
    ctx.fillRect(tx + tile * 0.34, ty + tile * 0.28, bar, tile * 0.44);
    ctx.fillRect(tx + tile * 0.66 - bar, ty + tile * 0.28, bar, tile * 0.44);

    ctx.direction = 'rtl';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#f4f6fb';
    ctx.font = `600 ${Math.round(h * 0.075)}px ${FONT}`;
    ctx.fillText('استراحة قصيرة', w / 2, h * 0.5);

    ctx.fillStyle = '#a3adc2';
    ctx.font = `400 ${Math.round(h * 0.04)}px ${FONT}`;
    ctx.fillText(text || 'نعود بعد قليل — ابقَ معنا', w / 2, h * 0.6, w * 0.86);

    ctx.fillStyle = '#8ea8ff';
    ctx.font = `500 ${Math.round(h * 0.036)}px ${FONT}`;
    ctx.fillText(`متوقف منذ ${formatElapsed(Date.now() - since)}`, w / 2, h * 0.69);

    ctx.fillStyle = '#667089';
    ctx.font = `400 ${Math.round(h * 0.03)}px ${FONT}`;
    ctx.fillText(room ? `مجلس ظمرة · ${room}` : 'مجلس ظمرة', w / 2, h * 0.9);
  };

  draw();
  // A timer, not requestAnimationFrame: it keeps ticking (throttled) in a
  // background tab, where rAF stops.
  const timer = setInterval(draw, 1000);
  const stream = canvas.captureStream(5);
  const [track] = stream.getVideoTracks();
  track.contentHint = 'detail';
  const stopTrack = track.stop.bind(track);
  const stop = () => {
    clearInterval(timer);
    stopTrack();
  };
  track.stop = stop;
  return {
    stream,
    track,
    setNote(next) {
      text = next;
      draw();
    },
    stop,
  };
}
