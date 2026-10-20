// Orchestrates watching (WHEP) and broadcasting (WHIP) and exposes one store
// the UI reads from. Only one peer connection is alive at a time: a host
// stops watching while on air, so the machine never decodes and encodes the
// same stream at once.
import { authStore, signOut } from '../auth/session';
import { createStore } from '../lib/store';
import { prefsStore, setPref, toast } from '../ui/prefs';
import { VIDEO_CODECS, probeDecoder } from './codecs';
import { loadConfig, saveConfig, whepUrl, whipUrl } from './config';
import { captureSupport } from './device';
import { needsCapture, needsReconnect } from './hold';
import { createHoldCard } from './holdCard';
import { createNetworkGuard } from './networkGuard';
import { captureOptions, PRESETS } from './quality';
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
  // What the relay tells viewers about a hold: { since, note } or null.
  holdNotice: null,
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
// One id for the whole broadcast, reconnects included: the relay starts the
// channel's chat over only when it changes.
let session = '';
let holdCard = null;
// Hold, continue and camera switches each await capture; one at a time.
let holdBusy = false;
// A continue that needed a new WHIP session clears the viewers' hold notice
// only once the new session is live.
let pendingResume = false;
let captureAbort = null;
let wakeLock = null;
let wakePending = false;

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
  if (!pub || pub.hold || !publisher || manualBitratePending) return;
  const kbps = networkGuard(stats, pub.kbps, pub.requestedKbps);
  if (kbps === null) return;
  await applyBitrate(kbps, false);
}

// Explain the browser's adaptation without promising a resolution/FPS lock.
function cpuGuard(stats) {
  const pub = streamStore.get().publish;
  if (!pub || pub.hold || !publisher || pub.guarded) return;
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

const NO_SCREEN = 'هذا الجهاز لا يسمح بمشاركة الشاشة من المتصفح (الآيباد والآيفون). اختر الكاميرا، أو اتبع طرق مشاركة الشاشة في لوحة البث.';

const cameraVideo = (preset, fps, facing) => ({
  facingMode: { ideal: facing },
  width: { ideal: preset.width },
  height: { ideal: preset.height },
  frameRate: { ideal: fps },
});

async function capture(source, preset, fps, facing = 'user') {
  const md = navigator.mediaDevices;
  if (source === 'screen') {
    if (!md?.getDisplayMedia) throw new Error(NO_SCREEN);
    return md.getDisplayMedia(captureOptions(preset, fps));
  }
  if (source === 'camera') {
    if (!md?.getUserMedia) throw new Error('هذا المتصفح لا يتيح الكاميرا هنا — افتح الموقع عبر https في Safari أو Chrome.');
    return md.getUserMedia({
      video: cameraVideo(preset, fps, facing),
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }
  return createTestPattern({ width: preset.width, height: preset.height, fps });
}

function captureError(err) {
  if (err?.name === 'NotAllowedError') return 'تم إلغاء إذن المشاركة — اسمح للموقع بالكاميرا أو الشاشة من إعدادات المتصفح';
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'لم نجد كاميرا أو ميكروفون بهذه الإعدادات';
  if (err?.name === 'NotReadableError') return 'الكاميرا أو الميكروفون مستخدم في تطبيق آخر';
  return err?.message || String(err);
}

function watchCapture(stream, source) {
  captureAbort?.abort();
  captureAbort = new AbortController();
  const { signal } = captureAbort;
  const [video] = stream.getVideoTracks();
  if (!video) return;
  // The browser's "Stop sharing" ends the broadcast; while holding it only
  // means Continue asks for the screen again.
  video.addEventListener('ended', () => {
    if (!streamStore.get().publish?.hold) return stopLive();
    if (localStream === stream) localStream = null;
  }, { signal, once: true });
  if (source !== 'camera') return;
  // The system takes the camera for a call, or pauses it when the browser
  // leaves the foreground: hold instead of freezing on the last frame.
  let timer = 0;
  video.addEventListener('mute', () => {
    clearTimeout(timer);
    timer = setTimeout(() => video.muted && holdLive({ auto: true }), 1200);
  }, { signal });
  video.addEventListener('unmute', () => clearTimeout(timer), { signal });
  signal.addEventListener('abort', () => clearTimeout(timer));
}

function releaseCapture() {
  captureAbort?.abort();
  captureAbort = null;
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
}

// Phones and tablets dim and lock mid-broadcast otherwise, which stops capture.
async function keepAwake() {
  if (wakeLock || wakePending || document.hidden || !navigator.wakeLock || streamStore.get().role !== 'host') return;
  wakePending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (streamStore.get().role !== 'host') return lock.release();
    wakeLock = lock;
    lock.addEventListener('release', () => {
      if (wakeLock === lock) wakeLock = null;
    });
  } catch {
    // Low battery mode or no support: the screen may still sleep.
  } finally {
    wakePending = false;
  }
}

function letSleep() {
  const lock = wakeLock;
  wakeLock = null;
  lock?.release().catch(() => {});
}

function startPublisher(stream, { source, codecId, kbps, fps, contentHint }) {
  // A logged-in streamer sends their session; otherwise the saved name+password.
  const { token } = authStore.get();
  const { config } = streamStore.get();
  const music = source === 'screen';
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
      if (publisher !== current) return;
      if (status === 'unauthorized') {
        // Say why once and go back to watching instead of a stuck red chip.
        if (token) signOut();
        toast(message, 'warn');
        stopLive();
        return;
      }
      set({ status, message });
      if (status === 'live') {
        startStats(current.pc, 'host');
        if (pendingResume && !streamStore.get().publish?.hold) {
          pendingResume = false;
          set({ holdNotice: null });
        }
      } else {
        stopStats();
        set({ stats: null });
      }
    },
  });
  publisher = current;
  current.start();
}

export async function goLive({ source, preset, fps, codecId, contentHint, kbps, facing = 'user' }) {
  let stream;
  try {
    stream = await capture(source, preset, fps, facing);
  } catch (err) {
    return { ok: false, error: captureError(err) };
  }

  stopViewing();
  localStream = stream;
  watchCapture(stream, source);

  const codecLabel = VIDEO_CODECS.find((c) => c.id === codecId)?.label ?? codecId;
  cpuStrikes = 0;
  networkGuard = createNetworkGuard();
  bitrateRevision++;
  manualBitratePending = 0;
  pendingResume = false;
  set({
    role: 'host',
    stream,
    status: 'connecting',
    message: '',
    stats: null,
    holdNotice: null,
    previewHidden: source !== 'test' && preset.height >= 1440,
    publish: {
      source,
      presetId: preset.id,
      width: preset.width,
      height: preset.height,
      codecId,
      codecLabel,
      fps,
      kbps,
      requestedKbps: kbps,
      contentHint,
      facing,
      micOn: true,
      hasAudio: stream.getAudioTracks().length > 0,
      startedAt: Date.now(),
      hold: null,
      guarded: false,
      encodingError: '',
    },
  });

  // They always broadcast to their own channel, and the page follows so they
  // see their own chat.
  const { room } = authStore.get();
  const { config } = streamStore.get();
  if (room && room !== config.room) set({ config: saveConfig({ ...config, room }) });
  session = Math.random().toString(36).slice(2, 10);
  startPublisher(stream, { source, codecId, kbps, fps, contentHint });
  keepAwake();
  const settings = stream.getVideoTracks()[0]?.getSettings();
  if (settings?.width < preset.width || settings?.height < preset.height) {
    toast(`المصدر ${settings.width}×${settings.height} أصغر من الهدف؛ ${source === 'camera' ? 'هذه أعلى دقة تعطيها الكاميرا هنا.' : 'اختر تبويباً أو شاشة بالدقة المطلوبة.'}`, 'warn');
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
  pendingResume = false;
  releaseCapture();
  holdCard?.stop();
  holdCard = null;
  letSleep();
  set({ publish: null, stats: null, stream: null, status: 'idle', previewHidden: false, holdNotice: null });
  startViewing();
}

// Viewers keep their connection and see the hold card; nothing from the
// room is sent. The camera and mic are released; a shared screen stays
// picked so Continue doesn't ask for it again.
export async function holdLive({ note = '', auto = false } = {}) {
  const pub = streamStore.get().publish;
  if (!pub || pub.hold || !publisher || holdBusy) return;
  holdBusy = true;
  try {
    const since = Date.now();
    const card = createHoldCard({ width: pub.width, height: pub.height, note, room: streamStore.get().config.room, since });
    holdCard = card;
    if (pub.source !== 'screen') releaseCapture();
    set({ stream: card.stream, publish: { ...pub, hold: { since, note, auto } }, holdNotice: { since, note } });
    await publisher.replaceTracks({ video: card.track, audio: null }).catch(() => {
      // The next reconnect sends the card.
    });
    if (auto) toast('أوقفنا البث مؤقتاً لأن الكاميرا توقفت. اضغط «متابعة البث» عند رجوعك.', 'warn');
  } finally {
    holdBusy = false;
  }
}

export function setHoldNote(note) {
  const pub = streamStore.get().publish;
  if (!pub?.hold) return;
  const text = String(note).slice(0, 80);
  holdCard?.setNote(text);
  set({ publish: { ...pub, hold: { ...pub.hold, note: text } }, holdNotice: { since: pub.hold.since, note: text } });
}

// Continue, optionally with new settings. Only what changed is redone: the
// same codec swaps tracks on the open connection; a new codec needs a new
// session, and viewers reconnect to it by themselves.
export async function resumeLive(next = {}) {
  const pub = streamStore.get().publish;
  if (!pub?.hold || !publisher || holdBusy) return { ok: false };
  holdBusy = true;
  const preset = next.preset ?? PRESETS.find((p) => p.id === pub.presetId) ?? PRESETS[2];
  const target = {
    source: next.source ?? pub.source,
    fps: next.fps ?? pub.fps,
    codecId: next.codecId ?? pub.codecId,
    kbps: next.kbps ?? pub.requestedKbps,
    contentHint: next.contentHint ?? pub.contentHint,
    facing: next.facing ?? pub.facing,
  };
  let stream = localStream;
  try {
    const alive = localStream?.getVideoTracks()[0]?.readyState === 'live';
    if (needsCapture(pub, target, alive)) {
      stream = await capture(target.source, preset, target.fps, target.facing);
    } else if (preset.id !== pub.presetId || target.fps !== pub.fps) {
      const { width, height, frameRate } = captureOptions(preset, target.fps).video;
      await stream.getVideoTracks()[0].applyConstraints({ width, height, frameRate }).catch(() => {});
    }
    // Ended while the picker or permission prompt was open.
    if (!streamStore.get().publish?.hold || !publisher) {
      if (stream !== localStream) stream.getTracks().forEach((t) => t.stop());
      return { ok: false };
    }
    if (stream !== localStream) {
      releaseCapture();
      localStream = stream;
    }
    watchCapture(stream, target.source);

    const [video] = stream.getVideoTracks();
    const audio = stream.getAudioTracks()[0] ?? null;
    const { micOn } = streamStore.get().publish;
    if (audio) {
      audio.enabled = micOn;
      audio.contentHint = target.source === 'screen' ? 'music' : 'speech';
    }
    if (video) video.contentHint = target.contentHint;

    if (needsReconnect(pub, target, { hadAudio: publisher.hasAudio, hasAudio: Boolean(audio) })) {
      publisher.stop();
      stopStats();
      pendingResume = true;
      startPublisher(stream, target);
    } else {
      await publisher.replaceTracks({ video, audio });
      bitrateRevision++;
      await publisher.updateEncoding({ videoKbps: target.kbps, fps: target.fps, contentHint: target.contentHint }).catch(() => {
        // Kept as the target; the live panel reports the measured result.
      });
    }

    holdCard?.stop();
    holdCard = null;
    cpuStrikes = 0;
    networkGuard = createNetworkGuard();
    manualBitratePending = 0;
    set({
      stream,
      previewHidden: target.source !== 'test' && preset.height >= 1440,
      publish: {
        ...streamStore.get().publish,
        source: target.source,
        presetId: preset.id,
        width: preset.width,
        height: preset.height,
        codecId: target.codecId,
        codecLabel: VIDEO_CODECS.find((c) => c.id === target.codecId)?.label ?? target.codecId,
        fps: target.fps,
        kbps: target.kbps,
        requestedKbps: target.kbps,
        contentHint: target.contentHint,
        facing: target.facing,
        hasAudio: Boolean(audio),
        hold: null,
        guarded: false,
        encodingError: '',
      },
      ...(pendingResume ? {} : { holdNotice: null }),
    });
    keepAwake();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: captureError(err) };
  } finally {
    holdBusy = false;
  }
}

export function setMic(on) {
  const pub = streamStore.get().publish;
  if (!pub) return;
  localStream?.getAudioTracks().forEach((t) => {
    t.enabled = on;
  });
  set({ publish: { ...pub, micOn: on } });
}

// Front/back on phones and tablets, live, on the same connection.
export async function switchCamera() {
  const pub = streamStore.get().publish;
  if (!pub || pub.source !== 'camera' || pub.hold || holdBusy || !localStream) return;
  holdBusy = true;
  const preset = PRESETS.find((p) => p.id === pub.presetId) ?? PRESETS[2];
  const open = (facing) => navigator.mediaDevices.getUserMedia({ video: cameraVideo(preset, pub.fps, facing) });
  let lost = false;
  try {
    // Phones and tablets open one camera at a time.
    captureAbort?.abort();
    localStream.getVideoTracks().forEach((t) => t.stop());
    let facing = pub.facing === 'environment' ? 'user' : 'environment';
    let cam = await open(facing).catch(() => null);
    if (!cam) {
      facing = pub.facing;
      cam = await open(facing);
      toast('تعذر فتح الكاميرا الأخرى', 'warn');
    }
    const [track] = cam.getVideoTracks();
    track.contentHint = pub.contentHint;
    const stream = new MediaStream([track, ...localStream.getAudioTracks()]);
    localStream = stream;
    watchCapture(stream, 'camera');
    await publisher?.replaceTracks({ video: track });
    set({ stream, publish: { ...streamStore.get().publish, facing } });
  } catch (err) {
    toast(captureError(err), 'warn');
    lost = true;
  } finally {
    holdBusy = false;
  }
  // No camera at all now: show viewers the card rather than a frozen frame.
  if (lost) holdLive({ auto: true });
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

// Phones and tablets stop the camera as soon as the browser leaves the
// foreground: hold right away. Coming back re-takes the wake lock, which the
// system drops for hidden pages.
const CAMERA_STOPS_IN_BACKGROUND = !captureSupport().screen;
document.addEventListener('visibilitychange', () => {
  const pub = streamStore.get().publish;
  if (!pub) return;
  if (!document.hidden) return keepAwake();
  if (pub.source === 'camera' && CAMERA_STOPS_IN_BACKGROUND && !pub.hold) holdLive({ auto: true });
});
