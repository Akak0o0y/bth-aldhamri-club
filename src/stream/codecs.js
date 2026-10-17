// Capability probes are estimates; the actual encoder is checked in getStats.
// Prefer broadly compatible H.264 when the requested workload is supported.

export const VIDEO_CODECS = [
  { id: 'h264', mime: 'video/H264', label: 'H.264', note: 'الأخف على أجهزة المشاهدين' },
  { id: 'av1', mime: 'video/AV1', label: 'AV1', note: 'أعلى جودة لكل ميجابت' },
  { id: 'vp9', mime: 'video/VP9', label: 'VP9', note: 'ممتاز للنصوص والشاشات' },
  { id: 'vp8', mime: 'video/VP8', label: 'VP8', note: 'الأخف ترميزاً بدون كرت شاشة' },
];

const capsOf = (side) => {
  try {
    return side?.getCapabilities?.('video')?.codecs ?? [];
  } catch {
    return [];
  }
};

const sameMime = (a, b) => a.toLowerCase() === b.toLowerCase();

async function mediaInfo(method, mime, { width, height, fps, kbps }) {
  const mc = navigator.mediaCapabilities;
  if (!mc?.[method]) return null;
  try {
    return await mc[method]({
      type: 'webrtc',
      video: { contentType: mime, width, height, bitrate: kbps * 1000, framerate: fps },
    });
  } catch {
    return null; // Firefox has no 'webrtc' type
  }
}

export async function probeEncoders(target) {
  const sendable = capsOf(window.RTCRtpSender);
  return Promise.all(
    VIDEO_CODECS.map(async (codec) => {
      const advertised = sendable.some((c) => sameMime(c.mimeType, codec.mime));
      const kbps = target.codecKbps?.[codec.id] ?? target.kbps;
      const info = advertised ? await mediaInfo('encodingInfo', codec.mime, { ...target, kbps }) : null;
      return { ...codec, supported: advertised && info?.supported !== false, hw: info?.powerEfficient ?? null, smooth: info?.smooth ?? null };
    }),
  );
}

const decodeCache = new Map();
export async function probeDecoder(mime, target) {
  const key = `${mime}|${target.width}x${target.height}@${target.fps}|${target.kbps}`;
  if (!decodeCache.has(key)) {
    decodeCache.set(key, mediaInfo('decodingInfo', mime, target).then((info) => (info ? info.powerEfficient : null)));
  }
  return decodeCache.get(key);
}

export function pickAutoCodec(probes) {
  const ok = (id) => probes.find((p) => p.id === id && p.supported);
  for (const id of ['h264', 'av1', 'vp9', 'vp8']) {
    if (ok(id)?.hw && ok(id).smooth !== false) return id;
  }
  // No hardware encoder: OpenH264 / libvpx VP8 are the cheapest software paths.
  return ok('h264') ? 'h264' : ok('vp8') ? 'vp8' : probes.find((p) => p.supported)?.id ?? 'vp8';
}

// Put the chosen codec first; keep the rest as fallback in case the server
// doesn't accept it (e.g. an older MediaMTX without AV1).
export function preferCodec(transceiver, codecId) {
  const codec = VIDEO_CODECS.find((c) => c.id === codecId);
  if (!codec || !transceiver.setCodecPreferences) return;
  for (const side of [window.RTCRtpReceiver, window.RTCRtpSender]) {
    const all = capsOf(side);
    const chosen = all.filter((c) => sameMime(c.mimeType, codec.mime));
    if (!chosen.length) continue;
    try {
      transceiver.setCodecPreferences([...chosen, ...all.filter((c) => !chosen.includes(c))]);
      return;
    } catch {
      // Try the other capability list.
    }
  }
}
