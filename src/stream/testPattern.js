// Lightweight test source for checking the pipeline without a camera.
// 1280x720 @ 30fps: the static background is painted once into an offscreen
// canvas, each frame only blits it and draws a moving bar + a millisecond
// clock (open host and viewer side by side to eyeball real latency).

export function createTestPattern({ width = 1280, height = 720, fps = 30 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });

  const bg = document.createElement('canvas');
  bg.width = width;
  bg.height = height;
  const b = bg.getContext('2d', { alpha: false });
  const grad = b.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, '#0a1430');
  grad.addColorStop(1, '#04060b');
  b.fillStyle = grad;
  b.fillRect(0, 0, width, height);
  b.fillStyle = '#f4f6fb';
  b.textAlign = 'center';
  b.font = '500 56px "Readex Pro", system-ui, sans-serif';
  b.fillText('مجلس ظمرة — بث تجريبي', width / 2, height / 2 - 70);
  b.fillStyle = '#a3adc2';
  b.font = '400 22px "Readex Pro", system-ui, sans-serif';
  b.fillText('قارن الساعة هنا مع شاشة المشاهد لقياس التأخير الفعلي', width / 2, height / 2 - 24);

  let timer = 0;
  let frame = 0;
  const draw = () => {
    frame++;
    ctx.drawImage(bg, 0, 0);
    const x = ((frame * 12) % (width + 160)) - 160;
    ctx.fillStyle = '#8ea8ff';
    ctx.fillRect(x, height / 2 + 120, 160, 10);
    const t = new Date();
    const ms = String(t.getMilliseconds()).padStart(3, '0');
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.font = '600 72px ui-monospace, "Cascadia Mono", Consolas, monospace';
    ctx.fillText(`${t.toLocaleTimeString('en-GB')}.${ms}`, width / 2, height / 2 + 80);
  };

  draw();
  timer = setInterval(draw, 1000 / fps);
  const stream = canvas.captureStream(fps);
  const [track] = stream.getVideoTracks();
  const stopTrack = track.stop.bind(track);
  track.stop = () => {
    clearInterval(timer);
    stopTrack();
  };
  return stream;
}
