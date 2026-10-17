// Realtime relay for مجلس ظمرة: chat, reactions, poll votes and the voice
// roster, per room. Everything lives in memory (the last 150 messages are all
// the history a live majlis needs), so the process idles at a few MB with no
// database. Voice audio itself never touches this server — speakers publish
// to MediaMTX over WHIP and listeners pull over WHEP; we only say who's on.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { createControlHub } from './control.js';
import {
  changePassword,
  checkPassword,
  createInvite,
  getInvite,
  isOwner,
  issueToken,
  listInvites,
  listUsers,
  readToken,
  redeemInvite,
  removeUser,
  revokeInvite,
  roomOf,
  seedAdmin,
  validName,
  validPass,
} from './accounts.js';

const PORT = Number(process.env.PORT) || 8787;
// Shared with MediaMTX so only it can ask /mtx/auth; unset means deny all.
const MTX_KEY = process.env.MTX_AUTH_KEY || '';
const VOICE_PATH = /^[^/]+-voice-[0-9a-f]{8}$/;
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

// Who's here, one name per device: tabs of one browser share a voter id.
function presence(room) {
  const voice = [];
  const people = new Map();
  for (const c of room.clients) {
    if (c.voice) voice.push({ id: c.id, name: c.name, host: c.host, ...c.voice });
    if (!people.has(c.voter)) people.set(c.voter, c.name);
  }
  return { t: 'presence', online: people.size, voice, people: [...people.values()].slice(0, 100) };
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

// A new broadcast starts its room's chat over. The studio tags every publish
// of one broadcast, reconnects included, with the same ?session=; OBS sends
// none, so all its publishes count as one broadcast.
const sessions = new Map();
function startSession(name, id) {
  if (sessions.get(name) === id) return;
  sessions.delete(name);
  sessions.set(name, id);
  if (sessions.size > MAX_ROOMS) sessions.delete(sessions.keys().next().value);
  const room = rooms.get(name);
  if (!room?.messages.length) return;
  room.messages = [];
  broadcast(room, { t: 'clear' });
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
    // Everyone's "who's here" list shows it; the token bucket stops spam.
    if (allow(ws)) broadcast(ws.room, presence(ws.room));
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

// --- accounts API --------------------------------------------------------------
// Bearer tokens, no cookies, so any origin may call it.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
};

function reply(res, status, body = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try {
        const body = JSON.parse(raw);
        resolve(body && typeof body === 'object' ? body : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] ?? null;

// Password guesses: 10 per 10 minutes per client, wherever they come in.
const attempts = new Map();
function guessAllowed(who) {
  const now = Date.now();
  const entry = attempts.get(who);
  if (!entry || now - entry.since > 600000) {
    attempts.set(who, { since: now, n: 1 });
    return true;
  }
  return ++entry.n <= 10;
}
const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// Owner-only routes: true for the owner's token; otherwise replies and is false.
function owner(req, res) {
  const name = readToken(bearer(req));
  if (name && isOwner(name)) return true;
  reply(res, name ? 403 : 401, { error: name ? 'owner' : 'session' });
  return false;
}

// MediaMTX asks before each publish to a main path (reads and voice paths are
// excluded in its config). A session token passes, and so does an account's
// name + password — OBS sends "name:password" as its Bearer token.
async function mtxAuth(req, res, url) {
  if (!MTX_KEY || url.searchParams.get('key') !== MTX_KEY) return reply(res, 403);
  const b = await readBody(req);
  if (b.action === 'read' || b.action === 'playback') return reply(res, 200);
  if (b.action !== 'publish') return reply(res, 401);
  if (typeof b.path === 'string' && VOICE_PATH.test(b.path)) return reply(res, 200);
  let name = readToken(b.token);
  let user = b.user;
  let pass = b.password;
  if (!name && typeof b.token === 'string' && b.token.includes(':')) {
    const i = b.token.indexOf(':');
    [user, pass] = [b.token.slice(0, i), b.token.slice(i + 1)];
  }
  if (!name && user && guessAllowed(`mtx:${b.ip}`)) name = await checkPassword(user, pass);
  // A streamer publishes to their own channel only.
  if (!name || roomOf(name) !== b.path) return reply(res, 401);
  startSession(b.path, new URLSearchParams(String(b.query ?? '')).get('session') ?? '');
  reply(res, 200);
}

// What the site needs to know about a signed-in streamer.
const profile = (name) => ({ name, owner: isOwner(name), room: roomOf(name) });

async function route(req, res) {
  const url = new URL(req.url, 'http://relay');
  const { pathname: path } = url;
  const post = req.method === 'POST';
  const get = req.method === 'GET';
  const del = req.method === 'DELETE';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (post && path === '/mtx/auth') return mtxAuth(req, res, url);

  if (post && path === '/api/login') {
    if (!guessAllowed(clientIp(req))) return reply(res, 429, { error: 'busy' });
    const b = await readBody(req);
    const name = await checkPassword(b.name, b.pass);
    return name ? reply(res, 200, { ...profile(name), token: issueToken(name) }) : reply(res, 401, { error: 'login' });
  }
  if (path === '/api/me') {
    const name = readToken(bearer(req));
    return name ? reply(res, 200, profile(name)) : reply(res, 401, { error: 'session' });
  }
  if (post && path === '/api/password') {
    const name = readToken(bearer(req));
    if (!name) return reply(res, 401, { error: 'session' });
    const b = await readBody(req);
    if (!validPass(b.pass)) return reply(res, 400, { error: 'pass' });
    if (!guessAllowed(clientIp(req))) return reply(res, 429, { error: 'busy' });
    if (!(await changePassword(name, b.current, b.pass))) return reply(res, 403, { error: 'current' });
    // Every other device is now signed out; this one carries on with a new token.
    return reply(res, 200, { token: issueToken(name) });
  }
  if (post && path === '/api/invites') {
    const name = readToken(bearer(req));
    return name ? reply(res, 200, createInvite(name)) : reply(res, 401, { error: 'session' });
  }
  if (get && path === '/api/users') return owner(req, res) && reply(res, 200, { users: listUsers() });
  if (get && path === '/api/invites') return owner(req, res) && reply(res, 200, { invites: listInvites() });
  const user = /^\/api\/users\/([^/]+)$/.exec(path)?.[1];
  if (del && user) {
    if (!owner(req, res)) return;
    return removeUser(decodeURIComponent(user)) ? reply(res, 200) : reply(res, 404, { error: 'user' });
  }
  const code = /^\/api\/invites\/([\w-]{6,32})$/.exec(path)?.[1];
  if (del && code) {
    if (!owner(req, res)) return;
    return revokeInvite(code) ? reply(res, 200) : reply(res, 404, { error: 'invite' });
  }
  if (code) {
    const invite = getInvite(code);
    return invite ? reply(res, 200, { by: invite.by, expires: invite.expires }) : reply(res, 404, { error: 'invite' });
  }
  if (post && path === '/api/register') {
    if (!guessAllowed(clientIp(req))) return reply(res, 429, { error: 'busy' });
    const b = await readBody(req);
    if (!validName(b.name)) return reply(res, 400, { error: 'name' });
    if (!validPass(b.pass)) return reply(res, 400, { error: 'pass' });
    const result = await redeemInvite(b.code, b.name, b.pass);
    if (result.error) return reply(res, result.error === 'taken' ? 409 : 404, result);
    return reply(res, 200, { ...profile(result.name), token: issueToken(result.name) });
  }

  // Health check for the host platform; also handy to eyeball load.
  let clients = 0;
  for (const room of rooms.values()) clients += room.clients.size;
  reply(res, path === '/' ? 200 : 404, { ok: path === '/', rooms: rooms.size, clients, controlProtocol: 1 });
}

const server = createServer((req, res) => {
  route(req, res).catch(() => reply(res, 500, { error: 'server' }));
});

const wss = new WebSocketServer({
  server,
  maxPayload: 4096,
  perMessageDeflate: false,
  verifyClient: ({ origin, req }) => (req.url === '/control' && !origin) || !ORIGINS.length || ORIGINS.includes('*') || ORIGINS.includes(origin),
});

const controlHub = createControlHub({ authenticate: readToken, roomOf });
wss.on('connection', (ws, req) => {
  if (req.url === '/control') { ws.remoteControl = true; return controlHub.attach(ws); }
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
    // Control sockets have their own shorter application heartbeat/watchdog.
    if (ws.remoteControl) continue;
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [who, entry] of attempts) if (now - entry.since > 600000) attempts.delete(who);
}, 25000).unref();

await seedAdmin(process.env.ADMIN_USER, process.env.ADMIN_PASS);
server.listen(PORT, () => console.log(`majlis realtime on :${PORT}`));
