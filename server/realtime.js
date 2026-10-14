// Realtime relay for مجلس ظمرة: chat, reactions, poll votes and the voice
// roster, per room. Everything lives in memory (the last 150 messages are all
// the history a live majlis needs), so the process idles at a few MB with no
// database. Voice audio itself never touches this server — speakers publish
// to MediaMTX over WHIP and listeners pull over WHEP; we only say who's on.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_MESSAGES = 150;
const MAX_ROOMS = 200;
const ROOM_TTL = 6 * 60 * 60 * 1000; // keep an empty room's history for 6h
const REACTIONS = new Set(['heart', 'fire', 'clap', 'star', 'coffee']);
const ID = /^[a-z0-9]{6,16}$/;
const OPTION = /^[a-z]{1,16}$/;

const rooms = new Map();

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanRoom = (value) => clean(value, 64).replace(/^\/+|\/+$/g, '') || 'majlis';
const newId = () => randomBytes(4).toString('hex');

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const c of room.clients) if (c !== except) send(c, data);
}

function tally(room) {
  const out = {};
  for (const option of room.votes.values()) out[option] = (out[option] || 0) + 1;
  return out;
}

function presence(room) {
  const voice = [];
  for (const c of room.clients) if (c.voice) voice.push({ id: c.id, name: c.name, host: c.host, ...c.voice });
  return { t: 'presence', online: room.clients.size, voice };
}

// Token bucket: 10 burst, 2 per second after that. Extra frames are dropped.
function allow(ws) {
  const now = Date.now();
  ws.tokens = Math.min(10, ws.tokens + ((now - ws.refill) / 1000) * 2);
  ws.refill = now;
  if (ws.tokens < 1) return false;
  ws.tokens -= 1;
  return true;
}

function join(ws, msg) {
  const name = cleanRoom(msg.room);
  let room = rooms.get(name);
  if (!room) {
    if (rooms.size >= MAX_ROOMS) return ws.close(1013, 'busy');
    room = { clients: new Set(), messages: [], votes: new Map(), seq: 0, idle: null };
    rooms.set(name, room);
  }
  clearTimeout(room.idle);

  const id = ID.test(msg.id) ? msg.id : newId();
  // Same id again means the old socket died without a close frame: newest wins.
  for (const c of room.clients) {
    if (c.id === id) {
      room.clients.delete(c);
      c.room = null;
      c.terminate();
    }
  }
  ws.room = room;
  ws.roomName = name;
  ws.id = id;
  ws.voter = ID.test(msg.voter) ? msg.voter : id;
  ws.name = clean(msg.name, 32) || 'ضيف';
  ws.host = Boolean(msg.host);
  ws.voice = null;
  room.clients.add(ws);

  send(ws, {
    t: 'init',
    you: id,
    messages: room.messages,
    votes: tally(room),
    myVote: room.votes.get(ws.voter) ?? null,
  });
  broadcast(room, presence(room));
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  ws.room = null;
  room.clients.delete(ws);
  if (room.clients.size) {
    broadcast(room, presence(room));
  } else {
    const name = ws.roomName;
    room.idle = setTimeout(() => rooms.delete(name), ROOM_TTL);
  }
}

const handlers = {
  chat(ws, msg) {
    const text = clean(msg.text, 400);
    if (!text || !allow(ws)) return;
    const room = ws.room;
    const out = { id: ++room.seq, from: ws.id, name: ws.name, text, ts: Date.now() };
    if (ws.host) out.host = true;
    if (REACTIONS.has(msg.icon)) out.icon = msg.icon;
    if (typeof msg.cid === 'string') out.cid = msg.cid.slice(0, 12);
    room.messages.push(out);
    if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
    broadcast(room, { t: 'chat', msg: out });
  },

  react(ws, msg) {
    if (REACTIONS.has(msg.key) && allow(ws)) broadcast(ws.room, { t: 'react', key: msg.key }, ws);
  },

  // One vote per device; every tab of that device learns it was used.
  vote(ws, msg) {
    const room = ws.room;
    if (!OPTION.test(msg.option)) return;
    // Already voted (e.g. from another tab): correct this tab's optimistic count.
    if (room.votes.has(ws.voter)) return send(ws, { t: 'votes', votes: tally(room), myVote: room.votes.get(ws.voter) });
    room.votes.set(ws.voter, msg.option);
    const votes = tally(room);
    for (const c of room.clients) send(c, c.voter === ws.voter ? { t: 'votes', votes, myVote: msg.option } : { t: 'votes', votes });
  },

  name(ws, msg) {
    const name = clean(msg.name, 32);
    if (!name || name === ws.name) return;
    ws.name = name;
    if (ws.voice) broadcast(ws.room, presence(ws.room));
  },

  host(ws, msg) {
    ws.host = Boolean(msg.on);
    if (ws.voice) broadcast(ws.room, presence(ws.room));
  },

  // { on: false } leaves the lounge; otherwise { mic, hand } is the new state.
  voice(ws, msg) {
    ws.voice = msg.on === false ? null : { mic: Boolean(msg.mic), hand: Boolean(msg.hand) };
    broadcast(ws.room, presence(ws.room));
  },
};

const server = createServer((req, res) => {
  // Health check for the host platform; also handy to eyeball load.
  let clients = 0;
  for (const room of rooms.values()) clients += room.clients.size;
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ ok: true, rooms: rooms.size, clients }));
});

const wss = new WebSocketServer({
  server,
  maxPayload: 4096,
  perMessageDeflate: false,
  verifyClient: ({ origin }) => !ORIGINS.length || ORIGINS.includes(origin),
});

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.tokens = 10;
  ws.refill = Date.now();
  ws.on('pong', () => {
    ws.alive = true;
  });
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (!ws.room) {
      if (msg.t === 'hello') join(ws, msg);
      return;
    }
    if (Object.hasOwn(handlers, msg.t)) handlers[msg.t](ws, msg);
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

// Proxies drop idle sockets; a ping every 25s keeps them open and reaps the
// ones whose network vanished.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
}, 25000).unref();

server.listen(PORT, () => console.log(`majlis realtime on :${PORT}`));
