// One WebSocket per tab to the realtime relay (server/realtime.js): chat,
// reactions, poll votes and who is in the voice lounge. Frames are a few
// hundred bytes and nothing polls — an idle chat costs one ping every 25s.
import { createStore, readJSON, writeJSON } from '../lib/store';
import { soundFX } from '../services/soundEffects';
import { streamStore } from '../stream/controller';
import { emitReaction, prefsStore } from '../ui/prefs';
import { relayUrl } from './relay';

const MAX_MESSAGES = 150;
const VOTER_KEY = 'majlis.voter.v1';
const ID = /^[a-z0-9]{6,16}$/;

// crypto.randomUUID needs https; getRandomValues also works on a LAN http page.
const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');

// Polls allow one vote per device, so the voter id outlives the tab.
const voter = (() => {
  const saved = readJSON(VOTER_KEY, { id: '' });
  if (ID.test(saved.id)) return saved.id;
  const id = randomId();
  writeJSON(VOTER_KEY, { id });
  return id;
})();

const SOUNDS = {
  coffee: () => soundFX.playCoffeePour(),
  fire: () => soundFX.playHype(),
  clap: () => soundFX.playApplause(),
  star: () => soundFX.playRoyalChime(),
};

export const rtStore = createStore({
  status: 'idle', // idle | connecting | open | closed
  you: null,
  messages: [],
  votes: {},
  myVote: null,
  online: 0,
  voice: [], // [{ id, name, host, mic, hand }]
});

const set = rtStore.set;
const openListeners = new Set();
let ws = null;
let started = false;
let retries = 0;
let retryTimer = null;
let myId = randomId();
let cidSeq = 0;
let lastRemoteSound = 0;

function send(msg) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}

function connect() {
  clearTimeout(retryTimer);
  set({ status: 'connecting' });
  let socket;
  try {
    socket = new WebSocket(relayUrl());
  } catch {
    return scheduleRetry();
  }
  ws = socket;
  socket.onopen = () => {
    const { config, role } = streamStore.get();
    send({ t: 'hello', room: config.room, id: myId, voter, name: prefsStore.get().username, host: role === 'host' });
  };
  socket.onmessage = (e) => {
    if (ws !== socket) return;
    try {
      receive(JSON.parse(e.data));
    } catch {
      // Malformed frame: ignore it rather than drop the connection.
    }
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    set({ status: 'closed', online: 0, voice: [] });
    scheduleRetry();
  };
}

function scheduleRetry() {
  retries++;
  retryTimer = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(retries - 1, 4)));
}

function reconnect() {
  const old = ws;
  ws = null;
  old?.close();
  retries = 0;
  set({ messages: [], votes: {}, myVote: null, online: 0, voice: [] });
  connect();
}

function receive(msg) {
  switch (msg.t) {
    case 'init':
      retries = 0;
      myId = msg.you;
      set({ status: 'open', you: msg.you, messages: msg.messages, votes: msg.votes, myVote: msg.myVote });
      openListeners.forEach((fn) => fn());
      break;
    case 'chat': {
      const m = msg.msg;
      set((s) => {
        // Our own echo replaces the optimistic copy shown at send time.
        const list = m.from === s.you && m.cid ? s.messages.filter((x) => !(x.pending && x.cid === m.cid)) : s.messages;
        return { messages: [...list.slice(-(MAX_MESSAGES - 1)), m] };
      });
      break;
    }
    case 'react': {
      emitReaction(msg.key);
      // A busy room shouldn't turn into a wall of sound.
      const now = performance.now();
      if (now - lastRemoteSound > 800) {
        lastRemoteSound = now;
        SOUNDS[msg.key]?.();
      }
      break;
    }
    case 'votes':
      set(msg.myVote ? { votes: msg.votes, myVote: msg.myVote } : { votes: msg.votes });
      break;
    case 'presence':
      set({ online: msg.online, voice: msg.voice });
      break;
  }
}

export function startRealtime() {
  if (started) return;
  started = true;
  connect();

  let { username } = prefsStore.get();
  let nameTimer = null;
  prefsStore.subscribe(() => {
    const next = prefsStore.get().username;
    if (next === username) return;
    username = next;
    clearTimeout(nameTimer);
    nameTimer = setTimeout(() => send({ t: 'name', name: username }), 600);
  });

  let { role, config } = streamStore.get();
  streamStore.subscribe(() => {
    const s = streamStore.get();
    if (s.role !== role) {
      role = s.role;
      send({ t: 'host', on: role === 'host' });
    }
    if (s.config !== config) {
      const moved = s.config.room !== config.room;
      config = s.config;
      if (moved) reconnect();
    }
  });
}

// Runs after every (re)connect, once the server has replayed the room state.
export function onRealtimeOpen(fn) {
  openListeners.add(fn);
  return () => openListeners.delete(fn);
}

export function sendChat(text, icon) {
  const cid = `c${++cidSeq}`;
  if (!send({ t: 'chat', text, icon, cid })) return false;
  const s = rtStore.get();
  const mine = { id: `p${cid}`, cid, pending: true, from: s.you, name: prefsStore.get().username, text, icon, ts: Date.now() };
  if (streamStore.get().role === 'host') mine.host = true;
  set({ messages: [...s.messages.slice(-(MAX_MESSAGES - 1)), mine] });
  return true;
}

export function sendReaction(key) {
  emitReaction(key);
  SOUNDS[key]?.();
  send({ t: 'react', key });
}

export function castVote(option) {
  const s = rtStore.get();
  if (s.myVote || !send({ t: 'vote', option })) return;
  set({ myVote: option, votes: { ...s.votes, [option]: (s.votes[option] || 0) + 1 } });
}

export function sendVoice(state) {
  send({ t: 'voice', ...state });
}
