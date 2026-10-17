// Browser-side attended control. Media continues through the existing player;
// the relay authorizes input and the native host asks for local approval.
import { trustedRelay } from '../realtime/trustedRelay.js';

export function controlEndpoint(relay, options) {
  return new URL('/control', trustedRelay(relay, options)).href;
}

export function createBrowserControl({ url, room, token, canControl, onState = () => {}, socketFactory = value => new WebSocket(value), now = Date.now }) {
  if (!/^[a-z0-9_-]{1,64}$/i.test(room) || !token) throw new Error('invalid-session');
  let socket;
  try { socket = socketFactory(url); } catch {
    const failed = { phase: 'closed', available: false, busy: false, reason: 'connection' };
    onState(failed);
    return { get: () => failed, close() {}, stop() {}, tick() {}, request: () => false, input: () => false };
  }
  let state = { phase: 'connecting', available: false, busy: false, display: null, reason: '', cooldown: false };
  let session = '', sequence = 0, expires = 0, pendingUntil = 0, nextRequest = 0, lastPong = now(), closed = false;
  const set = patch => { state = { ...state, ...patch }; onState(state); };
  const send = message => {
    if (closed || socket.readyState !== 1) return false;
    if (socket.bufferedAmount > 16384) { close('connection'); return false; }
    try { socket.send(JSON.stringify(message)); return true; } catch { close('connection'); return false; }
  };
  const end = reason => { if (closed) return; session = ''; sequence = 0; pendingUntil = 0; set({ phase: 'ready', reason }); };
  function stop(reason = 'stopped') {
    if (closed) return;
    const involved = session || state.phase === 'pending';
    if (!involved) return;
    session = ''; pendingUntil = 0;
    if (involved && !send({ t: 'stop' })) return;
    end(reason);
  }
  function close(reason = 'connection') {
    if (closed) return;
    closed = true; clearInterval(timer);
    if (socket.readyState === 1 && socket.bufferedAmount <= 16384) {
      try { socket.send(JSON.stringify({ t: 'stop' })); } catch { /* closing transport */ }
    }
    session = ''; pendingUntil = 0; socket.close();
    set({ phase: 'closed', available: false, busy: false, reason });
  }
  function tick() {
    if (closed) return;
    if (now() - lastPong > 4500) { close('connection'); return; }
    if ((session || state.phase === 'pending') && !canControl()) stop('context');
    if (session && now() >= expires) stop('expired');
    if (pendingUntil && now() >= pendingUntil) stop('expired');
    if (state.cooldown && now() >= nextRequest) set({ cooldown: false });
    send({ t: 'ping' });
  }
  const timer = setInterval(tick, 1000); timer.unref?.();
  socket.addEventListener('open', () => { if (closed) return; set({ phase: 'connecting' }); send({ t: 'hello', role: 'viewer', room, token }); });
  socket.addEventListener('message', event => {
    if (closed || typeof event.data !== 'string' || event.data.length > 4096) return;
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'pong') { lastPong = now(); return; }
    if (msg.t === 'ready') { lastPong = now(); set({ phase: 'ready' }); }
    else if (msg.t === 'state') set({ available: msg.available === true, busy: msg.busy === true, display: msg.display });
    else if (msg.t === 'pending') {
      // A cancellation may have crossed this acknowledgement in flight.
      if (state.phase !== 'pending') send({ t: 'stop' });
    } else if (msg.t === 'granted') {
      if (state.phase !== 'pending' || !canControl() || !/^[a-f0-9]{32}$/.test(msg.session || '') || !Number.isFinite(msg.expires) || msg.expires <= now()) {
        send({ t: 'stop' }); end('context'); return;
      }
      session = msg.session; sequence = 0; pendingUntil = 0; expires = Math.min(msg.expires, now() + 600000);
      set({ phase: 'active', display: msg.display, reason: '' });
    } else if (msg.t === 'ended') end(msg.reason?.includes('declined') ? 'declined' : msg.reason?.includes('expired') ? 'expired' : 'stopped');
    else if (msg.t === 'error') {
      if (state.phase === 'connecting') close('request-failed');
      else { stop('request-failed'); end('request-failed'); }
    }
  });
  socket.addEventListener('error', () => close('connection'));
  socket.addEventListener('close', () => close('connection'));
  return {
    get: () => state, close, stop, tick,
    request() {
      if (closed || state.phase !== 'ready' || !state.available || state.busy || !canControl() || now() < nextRequest) return false;
      nextRequest = now() + 5000; pendingUntil = now() + 31000;
      set({ phase: 'pending', reason: '', cooldown: true });
      return send({ t: 'request' });
    },
    input(event) {
      if (!session || !canControl() || now() >= expires) { if (session) stop('context'); return false; }
      return send({ t: 'input', session, seq: ++sequence, event });
    },
  };
}
