// SDR reference chart with native requested dimensions and a moving frame clock.
// The chart is drawn once; only the lower motion/clock strip changes per frame.
export const COLOR_PATCHES = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff', '#000000'];

export function createTestPattern({ width = 1280, height = 720, fps = 30 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false, colorSpace: 'srgb' });
  ctx.fillStyle = '#10141d';
  ctx.fillRect(0, 0, width, height);
  COLOR_PATCHES.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(i * width / 8, 0, Math.ceil(width / 8), height * 0.32);
  });
  // Shadow/highlight steps expose range clipping; the ramp exposes banding.
  const levels = [0, 4, 8, 12, 16, 24, 32, 48, 208, 224, 235, 240, 244, 248, 252, 255];
  levels.forEach((v, i) => {
    ctx.fillStyle = `rgb(${v} ${v} ${v})`;
    ctx.fillRect(i * width / levels.length, height * 0.34, Math.ceil(width / levels.length), height * 0.12);
  });
  const ramp = ctx.createLinearGradient(0, 0, width, 0);
  ramp.addColorStop(0, '#000');
  ramp.addColorStop(1, '#fff');
  ctx.fillStyle = ramp;
  ctx.fillRect(0, height * 0.48, width, height * 0.12);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#f4f6fb';
  ctx.font = `500 ${Math.round(height * 0.035)}px system-ui, sans-serif`;
  ctx.fillText(`SDR · ${width} × ${height} · target ${fps} fps`, width / 2, height * 0.67);

  let frame = 0;
  let timer = 0;
  let last = -Infinity;
  let stopped = false;
  const draw = (now) => {
    if (stopped) return;
    if (now - last >= 1000 / fps - 1) {
      last = now;
      frame++;
      ctx.fillStyle = '#10141d';
      ctx.fillRect(0, height * 0.7, width, height * 0.3);
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${Math.round(height * 0.06)}px monospace`;
      ctx.fillText(`${Date.now()}  #${frame}`, width / 2, height * 0.82);
      ctx.fillStyle = '#8ea8ff';
      ctx.fillRect(((now * width / 1800) % (width + 100)) - 100, height * 0.9, 100, height * 0.04);
    }
    timer = requestAnimationFrame(draw);
  };
  draw(performance.now());
  const stream = canvas.captureStream(fps);
  const [track] = stream.getVideoTracks();
  const stopTrack = track.stop.bind(track);
  track.stop = () => {
    stopped = true;
    cancelAnimationFrame(timer);
    stopTrack();
  };
  return stream;
}
