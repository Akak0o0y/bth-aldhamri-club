// Orchestrates watching (WHEP) and broadcasting (WHIP) and exposes one store
// the UI reads from. Only one peer connection is alive at a time: a host
// stops watching while on air, so the machine never decodes and encodes the
// same stream at once.
import { authStore, signOut } from '../auth/session';
import { createStore } from '../lib/store';
import { prefsStore, setPref, toast } from '../ui/prefs';
import { VIDEO_CODECS, probeDecoder } from './codecs';
import { loadConfig, saveConfig, whepUrl, whipUrl } from './config';
import { createSampler } from './stats';
import { createTestPattern } from './testPattern';
import { WhepPlayer } from './whep';
import { WhipPublisher } from './whip';

// Bitrates per codec at 60fps; AV1 needs ~40% less for the same picture.
export const PRESETS = [
  { id: '2160', label: '4K', name: 'Ultra HD', width: 3840, height: 2160, kbps: { h264: 20000, av1: 12000, vp9: 14000, vp8: 24000 } },
  { id: '1440', label: '2K', name: 'QHD', width: 2560, height: 1440, kbps: { h264: 12000, av1: 7000, vp9: 8000, vp8: 14000 } },
  { id: '1080', label: '1080p', name: 'Full HD', width: 1920, height: 1080, kbps: { h264: 7000, av1: 4000, vp9: 4500, vp8: 8000 } },
  { id: '720', label: '720p', name: 'HD', width: 1280, height: 720, kbps: { h264: 3500, av1: 2000, vp9: 2500, vp8: 4000 } },
];

export function presetKbps(preset, codecId, fps) {
  const base = preset.kbps[codecId] ?? preset.kbps.h264;
  return Math.round((fps >= 50 ? base : base * 0.65) / 100) * 100;
}

export const streamStore = createStore({
  role: 'viewer', // 'viewer' | 'host'
  status: 'idle', // idle | connecting | live | reconnecting | offline | unreachable | error
  message: '',
  stream: null,
  stats: null,
  hwDecode: null,
  config: loadConfig(),
  publish: null,
  previewHidden: false,
});

const set = streamStore.set;
let player = null;
let publisher = null;
let localStream = null;
let statsTimer = null;
let cpuStrikes = 0;
let decodeKey = '';

// --- stats -----------------------------------------------------------------

function stopStats() {
  clearInterval(statsTimer);
  statsTimer = null;
}

function startStats(pc, role) {
  stopStats();
  if (!pc) return;
  const sample = createSampler(pc, role);
  statsTimer = setInterval(async () => {
    if (role === 'viewer' && document.hidden) return;
    try {
      const stats = await sample();
      set({ stats });
      if (role === 'viewer') checkDecoder(stats);
      else {
        tcpGuard(stats);
        cpuGuard(stats);
      }
    } catch {
      // Connection closed between two ticks.
    }
  }, 1000);
}

function checkDecoder(stats) {
  if (stats.hw !== null) return set({ hwDecode: stats.hw });
  if (!stats.codec || !stats.width) return;
  const key = `${stats.codec}:${stats.width}x${stats.height}`;
  if (key === decodeKey) return;
  decodeKey = key;
  probeDecoder(`video/${stats.codec}`, {
    width: stats.width,
    height: stats.height,
    fps: stats.fps || 30,
    kbps: stats.kbps || 4000,
  }).then((hw) => set({ hwDecode: hw }));
}

// A server without public UDP (Railway) carries media over ICE-TCP, where any
// bitrate the uplink can't keep up with queues as seconds of delay instead of
// being dropped. Measured on that path: 2 Mbps held ~230 ms, 4 Mbps already
// spiked past 500 ms. So once we see a TCP route, cap to what stays live.
function tcpGuard(stats) {
  const pub = streamStore.get().publish;
  if (!pub || !publisher || pub.tcpCap || stats.protocol !== 'tcp') return;
  const height = PRESETS.find((p) => p.id === pub.presetId)?.height ?? 1080;
  const tcpCap = height > 720 ? 3000 : 2500;
  const kbps = Math.min(pub.kbps, tcpCap);
  const fps = Math.min(pub.fps, 30);
  publisher.updateEncoding({ videoKbps: kbps, fps, scaleDown: height > 1080 ? height / 1080 : undefined });
  set({ publish: { ...pub, kbps, fps, tcpCap } });
  if (kbps < pub.kbps || fps < pub.fps) {
    toast(`السيرفر يعمل عبر TCP — خفّضنا البث إلى ${kbps / 1000} Mbps و${fps} إطاراً ليبقى التأخير أقل من ثانية`, 'warn');
  }
}

// Chrome already adapts under load, but stepping 60 -> 30fps ourselves is
// steadier than letting the encoder oscillate — and we can tell the host why.
function cpuGuard(stats) {
  const pub = streamStore.get().publish;
  if (!pub || !publisher || pub.guarded) return;
  cpuStrikes = stats.limitation === 'cpu' ? cpuStrikes + 1 : Math.max(0, cpuStrikes - 1);
  if (cpuStrikes < 6) return;
  cpuStrikes = 0;
  if (pub.fps > 30) {
    publisher.updateEncoding({ fps: 30 });
    set({ publish: { ...pub, fps: 30, guarded: true } });
    toast('المعالج مضغوط — خفّضنا البث إلى 30 إطار للحفاظ على السلاسة', 'warn');
  } else {
    set({ publish: { ...pub, guarded: true } });
    toast('المعالج مضغوط — جرّب دقة أقل أو كودك يعمل بكرت الشاشة', 'warn');
  }
}

// --- watching --------------------------------------------------------------

export function stopViewing() {
  player?.stop();
  player = null;
  stopStats();
}

export function startViewing() {
  stopViewing();
  decodeKey = '';
  const current = new WhepPlayer({
    url: whepUrl(streamStore.get().config),
    lowLatency: prefsStore.get().lowLatency,
    onStream: (stream) => set({ stream }),
    onStatus: (status, message) => {
      set({ status, message });
      if (status === 'live') {
        startStats(current.pc, 'viewer');
      } else {
        stopStats();
        set({ stats: null, ...(status === 'reconnecting' ? {} : { stream: null, hwDecode: null }) });
      }
    },
  });
  player = current;
  set({ role: 'viewer', stream: null, stats: null, hwDecode: null });
  current.start();
}

export function setLowLatency(on) {
  setPref({ lowLatency: on });
  player?.setLowLatency(on);
}

export function updateConfig(next) {
  const prev = streamStore.get().config;
  const config = saveConfig({ ...prev, ...next });
  set({ config });
  // Credentials only matter at the next broadcast; reconnect only when the
  // stream location itself changed.
  if (config.server === prev.server && config.room === prev.room) return;
  if (streamStore.get().role === 'viewer') startViewing();
  else toast('سيُستخدم السيرفر الجديد في البث القادم');
}

// --- broadcasting ----------------------------------------------------------

async function capture(source, preset, fps) {
  if (source === 'screen') {
    return navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { max: preset.width },
        height: { max: preset.height },
        frameRate: { ideal: fps, max: fps },
      },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
      systemAudio: 'include',
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude',
    });
  }
  if (source === 'camera') {
    return navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: fps } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }
  return createTestPattern({ fps: Math.min(fps, 30) });
}

export async function goLive({ source, preset, fps, codecId, contentHint, kbps }) {
  let stream;
  try {
    stream = await capture(source, preset, fps);
  } catch (err) {
    if (err?.name === 'NotAllowedError') return { ok: false, error: 'تم إلغاء إذن المشاركة' };
    return { ok: false, error: err?.message || String(err) };
  }

  stopViewing();
  localStream = stream;
  stream.getVideoTracks()[0]?.addEventListener('ended', () => stopLive(), { once: true });

  const music = source === 'screen';
  const codecLabel = VIDEO_CODECS.find((c) => c.id === codecId)?.label ?? codecId;
  cpuStrikes = 0;
  set({
    role: 'host',
    stream,
    status: 'connecting',
    message: '',
    stats: null,
    previewHidden: false,
    publish: { source, presetId: preset.id, codecId, codecLabel, fps, kbps, contentHint, guarded: false },
  });

  // A logged-in streamer sends their session; otherwise the saved name+password.
  // They always broadcast to their own channel, and the page follows so they
  // see their own chat.
  const { token, room } = authStore.get();
  let { config } = streamStore.get();
  if (room && room !== config.room) {
    config = saveConfig({ ...config, room });
    set({ config });
  }
  // One id for the whole broadcast, reconnects included: the relay starts the
  // channel's chat over only when it changes.
  const session = Math.random().toString(36).slice(2, 10);
  const current = new WhipPublisher({
    url: `${whipUrl(config)}?session=${session}`,
    token,
    user: config.publishUser,
    pass: config.publishPass,
    stream,
    codecId,
    videoKbps: kbps,
    fps,
    contentHint,
    music,
    audioKbps: music ? 128 : 64,
    onStatus: (status, message) => {
      if (status === 'unauthorized') {
        // Say why once and go back to watching instead of a stuck red chip.
        if (token) signOut();
        toast(message, 'warn');
        stopLive();
        return;
      }
      set({ status, message });
      if (status === 'live') startStats(current.pc, 'host');
      else {
        stopStats();
        set({ stats: null });
      }
    },
  });
  publisher = current;
  current.start();
  return { ok: true };
}

export function stopLive() {
  if (streamStore.get().role !== 'host') return;
  publisher?.stop();
  publisher = null;
  stopStats();
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  set({ publish: null, stats: null, stream: null, status: 'idle', previewHidden: false });
  startViewing();
}

export function setLiveBitrate(kbps) {
  const pub = streamStore.get().publish;
  if (!pub || !publisher) return;
  if (pub.tcpCap) kbps = Math.min(kbps, pub.tcpCap);
  publisher.updateEncoding({ videoKbps: kbps });
  set({ publish: { ...pub, kbps } });
}

export function setPreviewHidden(hidden) {
  set({ previewHidden: hidden });
}

addEventListener('pagehide', () => {
  player?.stop();
  publisher?.stop();
});
