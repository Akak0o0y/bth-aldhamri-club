// Voice lounge on the media server we already run: every open mic is one
// audio-only WHIP publish (~32 kbps Opus) on its own MediaMTX path, and every
// listener pulls the open mics over WHEP. The realtime channel only says who
// is in the lounge and whose mic is live, so nothing polls for speakers.
import { createStore } from '../lib/store';
import { whepUrl, whipUrl } from '../stream/config';
import { streamStore } from '../stream/controller';
import { WhepPlayer } from '../stream/whep';
import { WhipPublisher } from '../stream/whip';
import { toast } from '../ui/prefs';
import { onRealtimeOpen, rtStore, sendVoice } from './channel';

const LEVEL = 0.04; // RTP audioLevel (0..1) that counts as talking
const HOLD = 600; // ms someone stays "speaking" after dropping below LEVEL

export const voiceStore = createStore({
  joined: false,
  mic: 'off', // off | connecting | live
  deaf: false,
  hand: false,
  speaking: [], // ids, sorted
});

const players = new Map(); // id -> { player, audio }
const loudAt = new Map();
let publisher = null;
let micStream = null;
let meterTimer = null;
let warned = false;

const voicePath = (id) => {
  const { config } = streamStore.get();
  return { server: config.server, room: `${config.room}-voice-${id}` };
};

function announce() {
  const { joined, mic, hand } = voiceStore.get();
  sendVoice(joined ? { mic: mic === 'live', hand } : { on: false });
}

// Pull exactly the open mics in the roster, nothing more.
function sync() {
  const { joined, deaf } = voiceStore.get();
  const { voice, you } = rtStore.get();
  const live = new Set(joined ? voice.filter((m) => m.mic && m.id !== you).map((m) => m.id) : []);

  for (const [id, entry] of players) {
    if (live.has(id)) continue;
    entry.player.stop();
    entry.audio.srcObject = null;
    players.delete(id);
  }
  for (const id of live) {
    if (players.has(id)) continue;
    const audio = new Audio();
    audio.autoplay = true;
    audio.muted = deaf;
    const player = new WhepPlayer({
      url: whepUrl(voicePath(id)),
      // Speech prefers the browser's adaptive jitter buffer over zero-buffer.
      lowLatency: false,
      onStatus: () => {},
      onStream: (stream) => {
        if (audio.srcObject === stream) return;
        audio.srcObject = stream;
        audio.play().catch(() => {});
      },
    });
    players.set(id, { player, audio });
    player.start();
  }
}

// --- speaking meter --------------------------------------------------------
// Remote levels come free with every RTP packet (getSynchronizationSources);
// our own comes from the sender's media-source stats. 4 Hz, paused when hidden.

async function meter() {
  if (document.hidden) return;
  const now = performance.now();
  for (const [id, { player }] of players) {
    const receiver = player.pc?.getReceivers().find((r) => r.track.kind === 'audio');
    if ((receiver?.getSynchronizationSources()[0]?.audioLevel ?? 0) > LEVEL) loudAt.set(id, now);
  }
  if (publisher?.pc && voiceStore.get().mic === 'live') {
    const stats = await publisher.pc.getStats().catch(() => null);
    stats?.forEach((r) => {
      if (r.type === 'media-source' && r.kind === 'audio' && r.audioLevel > LEVEL) loudAt.set(rtStore.get().you, now);
    });
  }
  const speaking = [];
  for (const [id, at] of loudAt) {
    if (now - at < HOLD) speaking.push(id);
    else loudAt.delete(id);
  }
  speaking.sort();
  if (speaking.join() !== voiceStore.get().speaking.join()) voiceStore.set({ speaking });
}

function stopMeter() {
  clearInterval(meterTimer);
  meterTimer = null;
  loudAt.clear();
  voiceStore.set({ speaking: [] });
}

// --- mic -------------------------------------------------------------------

function publish() {
  publisher?.stop();
  const current = new WhipPublisher({
    url: whipUrl(voicePath(rtStore.get().you)),
    stream: micStream,
    contentHint: 'speech',
    music: false,
    audioKbps: 32,
    onStatus: (status, message) => {
      if (status === 'live') {
        warned = false;
        voiceStore.set({ mic: 'live' });
        return announce();
      }
      if (voiceStore.get().mic === 'live') {
        voiceStore.set({ mic: 'connecting' });
        announce();
      }
      if ((status === 'error' || status === 'unreachable') && !warned) {
        warned = true;
        toast(message || 'تعذر الوصول إلى سيرفر الصوت', 'warn');
      }
    },
  });
  publisher = current;
  current.start();
}

async function openMic() {
  voiceStore.set({ mic: 'connecting' });
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (err) {
    voiceStore.set({ mic: 'off' });
    toast(err?.name === 'NotAllowedError' ? 'لم يُسمح باستخدام المايك' : 'تعذر فتح المايك', 'warn');
    return;
  }
  // Left the lounge or closed the mic while the permission prompt was open.
  if (!voiceStore.get().joined || voiceStore.get().mic !== 'connecting') {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  micStream = stream;
  publish();
}

function closeMic() {
  publisher?.stop();
  publisher = null;
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  voiceStore.set({ mic: 'off' });
}

// --- public ----------------------------------------------------------------

export function joinVoice() {
  if (voiceStore.get().joined) return;
  voiceStore.set({ joined: true });
  announce();
  sync();
  meterTimer = setInterval(meter, 250);
}

export function leaveVoice() {
  if (!voiceStore.get().joined) return;
  closeMic();
  voiceStore.set({ joined: false, hand: false });
  announce();
  sync();
  stopMeter();
}

export function toggleMic() {
  if (voiceStore.get().mic === 'off') {
    openMic();
  } else {
    closeMic();
    announce();
  }
}

export function toggleDeaf() {
  const deaf = !voiceStore.get().deaf;
  voiceStore.set({ deaf });
  for (const { audio } of players.values()) audio.muted = deaf;
}

export function toggleHand() {
  voiceStore.set({ hand: !voiceStore.get().hand });
  announce();
}

let lastVoice = null;
rtStore.subscribe(() => {
  const { voice } = rtStore.get();
  if (voice === lastVoice) return;
  lastVoice = voice;
  sync();
});

// The relay forgets us when the socket drops; say where we are again.
onRealtimeOpen(() => {
  if (voiceStore.get().joined) announce();
});

addEventListener('pagehide', () => {
  publisher?.stop();
  for (const { player } of players.values()) player.stop();
});
