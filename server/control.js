// Attended remote input only. This channel never accepts shell commands,
// clipboard data, files, or a client-supplied claim of host authority.
import { randomBytes } from 'node:crypto';

const KEYS = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Arrow(Up|Down|Left|Right)|Enter|Escape|Backspace|Tab|Space|Delete|Insert|Home|End|PageUp|PageDown|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Meta(Left|Right)|CapsLock|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash)$/;
export function validInput(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const point = Number.isFinite(event.x) && Number.isFinite(event.y) && event.x >= 0 && event.x <= 1 && event.y >= 0 && event.y <= 1;
  if (event.kind === 'move') return point;
  if (event.kind === 'button') return point && [0, 1, 2].includes(event.button) && typeof event.down === 'boolean';
  if (event.kind === 'wheel') return Number.isInteger(event.delta) && Math.abs(event.delta) <= 1200;
  if (event.kind === 'key') return typeof event.code === 'string' && KEYS.test(event.code) && typeof event.down === 'boolean';
  return event.kind === 'reset';
}

export function createControlHub({ authenticate, roomOf, now = Date.now, requestMs = 30000, leaseMs = 600000, heartbeatMs = 5000 }) {
  const rooms = new Map(), clients = new Set();
  const identity = token => { try { return authenticate(token); } catch { return null; } };
  const id = () => randomBytes(16).toString('hex');
  const send = (client, message) => {
    if (!client || client.ws.readyState !== 1) return;
    if (client.ws.bufferedAmount > 65536) { client.ws.close(1008, 'control backpressure'); return; }
    client.ws.send(JSON.stringify(message));
  };
  const state = room => {
    for (const client of room.viewers) send(client, { t: 'state', available: Boolean(room.host), busy: Boolean(room.active || room.pending), display: room.host?.display });
  };
  function stop(room, reason) {
    const session = room.active || room.pending;
    room.active = room.pending = null;
    if (session) {
      send(room.host, { t: 'ended', reason });
      send(session.viewer, { t: 'ended', reason });
    }
    state(room);
  }
  function leave(client) {
    if (!clients.delete(client)) return;
    const room = client.room;
    if (!room) return;
    if (room.host === client) {
      stop(room, 'host disconnected'); room.host = null;
    } else if (room.pending?.viewer === client || room.active?.viewer === client) stop(room, 'viewer disconnected');
    room.viewers.delete(client);
    state(room);
    if (!room.host && !room.viewers.size) rooms.delete(client.roomName);
  }
  function attach(ws) {
    if (clients.size >= 400) { ws.close(1013, 'busy'); return; }
    const client = { ws, joined: false, lastSeen: now(), tokens: 240, refill: now(), nextRequest: 0 };
    clients.add(client);
    ws.on('close', () => leave(client));
    ws.on('error', () => {});
    ws.on('message', (raw, binary) => {
      if (!clients.has(client) || ws.readyState !== 1) return;
      if (binary || raw.length > 4096) return ws.close(1008, 'invalid control message');
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return ws.close(1008, 'invalid JSON'); }
      if (!msg || typeof msg !== 'object') return;
      if (!client.joined) {
        const name = typeof msg.token === 'string' && msg.token.length <= 2048 ? identity(msg.token) : null;
        if (msg.t !== 'hello' || !name || !['host', 'viewer'].includes(msg.role) || !/^[a-z0-9_-]{1,64}$/i.test(msg.room || '') || (msg.role === 'host' && roomOf(name) !== msg.room)) {
          send(client, { t: 'error', message: 'Sign in with a valid account for this channel.' }); ws.close(1008, 'unauthorized'); return;
        }
        if (msg.role === 'host') {
          const d = msg.display;
          if (!d || !Number.isInteger(d.width) || !Number.isInteger(d.height) || d.width < 320 || d.width > 16384 || d.height < 180 || d.height > 16384) { ws.close(1008, 'invalid display'); return; }
        }
        let room = rooms.get(msg.room);
        if (!room && rooms.size >= 200) { ws.close(1013, 'busy'); return; }
        if (!room) { room = { host: null, viewers: new Set(), pending: null, active: null }; rooms.set(msg.room, room); }
        if (msg.role === 'host') {
          const d = msg.display;
          if (room.host) {
            ws.close(1008, 'host unavailable'); return;
          }
          client.display = { width: d.width, height: d.height }; room.host = client;
        } else room.viewers.add(client);
        Object.assign(client, { joined: true, room, roomName: msg.room, role: msg.role, name, token: msg.token });
        send(client, { t: 'ready', role: client.role }); state(room); return;
      }
      if (identity(client.token) !== client.name || (client.role === 'host' && roomOf(client.name) !== client.roomName)) { ws.close(1008, 'session expired'); return; }
      const room = client.room;
      client.lastSeen = now();
      if (msg.t === 'ping') {
        send(client, { t: 'pong' });
        if (room.active?.viewer === client) send(room.host, { t: 'alive', session: room.active.id });
        return;
      }
      if (msg.t === 'request' && client.role === 'viewer') {
        if (client.nextRequest > now()) { send(client, { t: 'error', message: 'Wait before requesting again.' }); return; }
        client.nextRequest = now() + 5000;
        if (!room.host || room.pending || room.active) { send(client, { t: 'error', message: 'Streamer is unavailable or already handling a request.' }); return; }
        room.pending = { id: id(), viewer: client, expires: now() + requestMs };
        send(client, { t: 'pending' });
        send(room.host, { t: 'request', id: room.pending.id, name: client.name }); state(room); return;
      }
      if (msg.t === 'decision' && room.host === client && room.pending?.id === msg.id) {
        const pending = room.pending;
        if (pending.expires <= now() || msg.allow !== true) { stop(room, 'request declined or expired'); return; }
        room.pending = null;
        room.active = { id: id(), viewer: pending.viewer, expires: now() + leaseMs, sequence: 0 };
        const grant = { t: 'granted', session: room.active.id, expires: room.active.expires, display: client.display, name: pending.viewer.name };
        send(client, grant); send(pending.viewer, grant); state(room); return;
      }
      if (msg.t === 'stop' && (room.host === client || room.pending?.viewer === client || room.active?.viewer === client)) { stop(room, 'control stopped'); return; }
      if (msg.t === 'input') {
        const active = room.active;
        if (!active || active.viewer !== client || msg.session !== active.id) return;
        if (active.expires <= now()) { stop(room, 'control expired'); return; }
        client.tokens = Math.min(240, client.tokens + (now() - client.refill) * 0.24); client.refill = now();
        if (--client.tokens < 0 || !Number.isSafeInteger(msg.seq) || msg.seq <= active.sequence || !validInput(msg.event)) { stop(room, 'invalid or excessive input'); return; }
        active.sequence = msg.seq;
        // Forward a typed event, not arbitrary properties or executable text.
        const { kind, x, y, button, down, code, delta } = msg.event;
        send(room.host, { t: 'input', session: active.id, event: { kind, x, y, button, down, code, delta } });
      }
    });
  }
  function tick() {
    for (const client of [...clients]) {
      if (now() - client.lastSeen > heartbeatMs || (client.joined && (identity(client.token) !== client.name || (client.role === 'host' && roomOf(client.name) !== client.roomName)))) {
        leave(client); client.ws.close(1008, 'control heartbeat expired');
      }
    }
    for (const room of rooms.values()) {
      if ((room.pending && room.pending.expires <= now()) || (room.active && room.active.expires <= now())) stop(room, 'control expired');
    }
  }
  const timer = setInterval(tick, 500); timer.unref();
  return { attach, tick, close() { clearInterval(timer); for (const client of [...clients]) { leave(client); client.ws.close(); } } };
}
