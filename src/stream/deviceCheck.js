import { preferCodec } from './codecs';
import { applyVideoEncoding } from './encoding';
import { applyLatencyHints } from './latency';
import { createSampler } from './stats';
import { COLOR_PATCHES, createTestPattern } from './testPattern';

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function colorDifference(video) {
  if (!video.videoWidth || video.readyState < 2) return null;
  // Read only eight centre patches, not an entire 1440p frame.
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  let sum = 0;
  COLOR_PATCHES.forEach((hex, i) => {
    ctx.drawImage(video, (i + 0.5) * video.videoWidth / 8, video.videoHeight * 0.15, 1, 1, i, 0, 1, 1);
    const pixel = ctx.getImageData(i, 0, 1, 1).data;
    for (let c = 0; c < 3; c++) sum += Math.abs(pixel[c] - parseInt(hex.slice(1 + 2 * c, 3 + 2 * c), 16));
  });
  return Math.round(sum / 24 * 10) / 10;
}

// Local-only encode/decode check. No camera, account, media server or STUN.
// This does not measure upload, screen capture, HDR fidelity or end-to-end delay.
export async function checkDevice({ preset, fps, codecId, kbps, signal, onProgress = () => {} }) {
  let stream;
  let tx;
  let rx;
  let video;
  try {
    signal?.throwIfAborted();
    stream = createTestPattern({ ...preset, fps });
    tx = new RTCPeerConnection({ iceServers: [] });
    rx = new RTCPeerConnection({ iceServers: [] });
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = 'position:fixed;left:-10px;top:0;width:1px;height:1px;pointer-events:none';
    video.setAttribute('aria-hidden', 'true');
    document.body.append(video);
    rx.ontrack = ({ track, receiver }) => {
      applyLatencyHints(receiver, true);
      video.srcObject = new MediaStream([track]);
      video.play().catch(() => {});
    };
    const pendingTx = [];
    const pendingRx = [];
    tx.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      if (rx.remoteDescription) rx.addIceCandidate(candidate).catch(() => {});
      else pendingRx.push(candidate);
    };
    rx.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      if (tx.remoteDescription) tx.addIceCandidate(candidate).catch(() => {});
      else pendingTx.push(candidate);
    };
    const [track] = stream.getVideoTracks();
    track.contentHint = 'motion';
    const transceiver = tx.addTransceiver(track, {
      direction: 'sendonly', streams: [stream], sendEncodings: [{ maxBitrate: kbps * 1000, maxFramerate: fps }],
    });
    preferCodec(transceiver, codecId);
    await tx.setLocalDescription(await tx.createOffer());
    await rx.setRemoteDescription(tx.localDescription);
    for (const candidate of pendingRx.splice(0)) await rx.addIceCandidate(candidate);
    await rx.setLocalDescription(await rx.createAnswer());
    await tx.setRemoteDescription(rx.localDescription);
    for (const candidate of pendingTx.splice(0)) await tx.addIceCandidate(candidate);
    signal?.throwIfAborted();
    await applyVideoEncoding(transceiver.sender, { videoKbps: kbps, fps, contentHint: 'motion' });

    const sendSample = createSampler(tx, 'host');
    const receiveSample = createSampler(rx, 'viewer');
    const samples = [];
    for (let second = 1; second <= 20; second++) {
      await wait(1000, signal);
      if (document.hidden) throw new Error('أبقِ تبويب الاختبار ظاهراً لقياس الإطارات.');
      const [sent, received] = await Promise.all([sendSample(), receiveSample()]);
      signal?.throwIfAborted();
      onProgress(second * 5);
      if (second > 5) samples.push({ sent, received });
    }
    const last = samples.at(-1);
    const min = (select) => {
      const values = samples.map(select);
      return values.every(Number.isFinite) ? Math.min(...values) : null;
    };
    const sentFps = min((s) => s.sent.fps);
    const receivedFps = min((s) => s.received.fps);
    const captureFps = min((s) => s.sent.captureFps);
    const matched = samples.every(({ sent, received }) => sent.width === preset.width && sent.height === preset.height && received.width === preset.width && received.height === preset.height);
    const supportedRate = [sentFps, receivedFps, captureFps].every((v) => v !== null && v >= fps - 1);
    const cpuLimited = samples.some((s) => s.sent.limitation === 'cpu');
    return {
      passed: matched && supportedRate && !cpuLimited,
      sentFps, receivedFps, captureFps, codec: last.sent.codec, encoder: last.sent.impl,
      hw: last.sent.hw, width: last.received.width, height: last.received.height,
      colorError: colorDifference(video), cpuLimited,
    };
  } finally {
    if (tx) { tx.onicecandidate = null; tx.close(); }
    if (rx) { rx.onicecandidate = rx.ontrack = null; rx.close(); }
    stream?.getTracks().forEach((track) => track.stop());
    if (video) { video.pause(); video.srcObject = null; video.remove(); }
  }
}
