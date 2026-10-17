// Orchestrates watching (WHEP) and broadcasting (WHIP) and exposes one store
// the UI reads from. Only one peer connection is alive at a time: a host
// stops watching while on air, so the machine never decodes and encodes the
// same stream at once.
import { authStore, signOut } from '../auth/session';
import { createStore } from '../lib/store';
import { prefsStore, setPref, toast } from '../ui/prefs';
import { VIDEO_CODECS, probeDecoder } from './codecs';
import { loadConfig, saveConfig, whepUrl, whipUrl } from './config';
import { createNetworkGuard } from './networkGuard';
import { captureOptions } from './quality';
import { createSampler } from './stats';
import { createTestPattern } from './testPattern';
import { WhepPlayer } from './whep';
import { WhipPublisher } from './whip';

export { PRESETS, presetKbps } from './quality';

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
let statsEpoch = 0;
let networkGuard = createNetworkGuard();
let bitrateRevision = 0;
let manualBitratePending = 0;
let cpuStrikes = 0;
let decodeKey = '';

// --- stats -----------------------------------------------------------------

function stopStats() {
  statsEpoch++;
  clearInterval(statsTimer);
  statsTimer = null;
}

function startStats(pc, role) {
  stopStats();
  if (!pc) return;
  const sample = createSampler(pc, role);
  const epoch = statsEpoch;
  let sampling = false;
  statsTimer = setInterval(async () => {
    if (sampling || (role === 'viewer' && document.hidden)) return;
    sampling = true;
    try {
      const stats = await sample();
      if (epoch !== statsEpoch) return;
      if (role === 'host') {
        const settings = localStream?.getVideoTracks()[0]?.getSettings();
        stats.captureWidth ??= settings?.width ?? null;
        stats.captureHeight ??= settings?.height ?? null;
      }
      set({ stats });
      if (role === 'viewer') checkDecoder(stats, epoch);
      else {
        await guardNetwork(stats);
        if (epoch !== statsEpoch) return;
        cpuGuard(stats);
      }
    } catch {
      // Connection closed between two ticks.
    } finally {
      sampling = false;
    }
  }, 1000);
}

function checkDecoder(stats, epoch) {
  if (typeof stats.hw === 'boolean') {
    decodeKey = '';
    return set({ hwDecode: stats.hw });
  }
  if (!stats.codec || !stats.width) return;
  const key = `${stats.codec}:${stats.width}x${stats.height}`;
  if (key === decodeKey) return;
  decodeKey = key;
  probeDecoder(`video/${stats.codec}`, {
    width: stats.width,
    height: stats.height,
    fps: stats.fps || 30,
    kbps: stats.kbps || 4000,
  }).then((hw) => {
    if (epoch === statsEpoch && decodeKey === key) set({ hwDecode: hw });
  });
}

async function guardNetwork(stats) {
  const pub = streamStore.get().publish;
  if (!pub || !publisher || manualBitratePending) return;
  const kbps = networkGuard(stats, pub.kbps, pub.requestedKbps);
  if (kbps === null) return;
  await applyBitrate(kbps, false);
}

// Explain the browser's adaptation without promising a resolution/FPS lock.
function cpuGuard(stats) {
  const pub = streamStore.get().publish;
  if (!pub || !publisher || pub.guarded) return;
  cpuStrikes = stats.limitation === 'cpu' ? cpuStrikes + 1 : Math.max(0, cpuStrikes - 1);
  if (cpuStrikes < 6) return;
  cpuStrikes = 0;
  // The encoder already gives way as the streamer chose (see WhipPublisher):
  // just say what's happening and how to avoid it.
  set({ publish: { ...pub, guarded: true } });
  toast('الجهاز لا يلحق بالترميز — أغلق البرامج الثقيلة وتحقق من تسريع الرسوميات في المتصفح. راقب الدقة والإطارات الفعلية.', 'warn');
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
    return navigator.mediaDevices.getDisplayMedia(captureOptions(preset, fps));
  }
  if (source === 'camera') {
    return navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: preset.width }, height: { ideal: preset.height }, frameRate: { ideal: fps } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }
  return createTestPattern({ width: preset.width, height: preset.height, fps });
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
  networkGuard = createNetworkGuard();
  bitrateRevision++;
  manualBitratePending = 0;
  set({
    role: 'host',
    stream,
    status: 'connecting',
    message: '',
    stats: null,
    previewHidden: source !== 'test' && preset.height >= 1440,
    publish: { source, presetId: preset.id, width: preset.width, height: preset.height, codecId, codecLabel, fps, kbps, requestedKbps: kbps, contentHint, guarded: false, encodingError: '' },
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
  // Send native frames, preserving capture timestamps and colour metadata.
  // Duplicating frames at 60 Hz hid low capture rates and added processing.
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
    onEncodingError: () => {
      if (publisher !== current) return;
      const pub = streamStore.get().publish;
      if (pub) set({ publish: { ...pub, encodingError: 'المتصفح لم يطبّق إعدادات الترميز المطلوبة؛ راقب القياس الفعلي.' } });
    },
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
  const settings = stream.getVideoTracks()[0]?.getSettings();
  if (settings?.width < preset.width || settings?.height < preset.height) {
    toast(`المصدر ${settings.width}×${settings.height} أصغر من الهدف؛ اختر تبويباً أو شاشة بالدقة المطلوبة.`, 'warn');
  }
  return { ok: true };
}

export function stopLive() {
  if (streamStore.get().role !== 'host') return;
  publisher?.stop();
  publisher = null;
  stopStats();
  bitrateRevision++;
  manualBitratePending = 0;
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  set({ publish: null, stats: null, stream: null, status: 'idle', previewHidden: false });
  startViewing();
}

async function applyBitrate(kbps, manual) {
  const pub = streamStore.get().publish;
  const current = publisher;
  if (!pub || !current || !Number.isFinite(kbps)) return false;
  kbps = Math.max(1000, Math.min(30000, Math.round(kbps)));
  const revision = ++bitrateRevision;
  if (manual) {
    manualBitratePending = revision;
    networkGuard = createNetworkGuard();
  }
  try {
    const applied = await current.updateEncoding({ videoKbps: kbps });
    if (publisher !== current) return false;
    if (!applied && revision !== bitrateRevision) return false;
    if (!applied) throw new Error('Sender is not ready');
    // Record every successful serialized write. A newer queued change may
    // fail, in which case this intermediate value is the real sender setting.
    set({ publish: { ...streamStore.get().publish, kbps, ...(manual ? { requestedKbps: kbps } : {}), encodingError: '' } });
    return revision === bitrateRevision;
  } catch {
    if (publisher === current && revision === bitrateRevision) {
      set({ publish: { ...streamStore.get().publish, encodingError: 'تعذر تغيير معدل البت؛ الإعداد السابق ما زال مطلوباً.' } });
    }
    return false;
  } finally {
    if (manualBitratePending === revision) manualBitratePending = 0;
  }
}

export function setLiveBitrate(kbps) {
  return applyBitrate(kbps, true);
}

export function setPreviewHidden(hidden) {
  set({ previewHidden: hidden });
}

addEventListener('pagehide', () => {
  player?.stop();
  publisher?.stop();
});
