// Constant frame rate for screen capture. Chrome hands out a new screen frame
// only when something on screen changes, so a still scene drops to a few fps
// and a busy one wobbles. Like OBS, resend the latest frame on a fixed clock
// so the stream (and every viewer's fps counter) stays at exactly `fps`; a
// repeated frame costs the encoder next to nothing. The clock runs in a
// worker so it keeps time while the streamer is in another window.

const WORKER = `
let latest = null;
onmessage = async ({ data: { readable, writable, fps } }) => {
  const writer = writable.getWriter();
  const reader = readable.getReader();
  const period = 1000 / fps;
  const start = performance.now();
  let n = 0;
  let timer = 0;
  const tick = () => {
    // Skip a beat rather than queue frames the encoder hasn't taken yet.
    if (latest && writer.desiredSize > 0) {
      const frame = new VideoFrame(latest, { timestamp: Math.round(n * period * 1000) });
      writer.write(frame).catch(() => frame.close());
    }
    // Aim at the fixed grid, so timer drift never adds up; after a stall,
    // jump ahead instead of bursting the missed frames.
    n = Math.max(n + 1, Math.floor((performance.now() - start) / period) + 1);
    timer = setTimeout(tick, Math.max(0, start + n * period - performance.now()));
  };
  tick();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    latest?.close();
    latest = value;
  }
  clearTimeout(timer);
  latest?.close();
  writer.close().catch(() => {});
};
`;

// Returns { stream, stop } with the paced video plus the original audio, or
// null where the browser can't (then the raw capture is sent as before).
export function constantFrameRate(stream, fps) {
  const [video] = stream.getVideoTracks();
  if (!video || typeof MediaStreamTrackProcessor !== 'function' || typeof MediaStreamTrackGenerator !== 'function') return null;
  const processor = new MediaStreamTrackProcessor({ track: video });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const url = URL.createObjectURL(new Blob([WORKER], { type: 'text/javascript' }));
  const worker = new Worker(url);
  worker.postMessage({ readable: processor.readable, writable: generator.writable, fps }, [processor.readable, generator.writable]);
  return {
    stream: new MediaStream([generator, ...stream.getAudioTracks()]),
    stop() {
      worker.terminate();
      generator.stop();
      URL.revokeObjectURL(url);
    },
  };
}
