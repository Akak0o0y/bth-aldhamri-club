import { secureUrl } from './core.mjs';

export function controlUrl(relay) {
  const url = new URL(secureUrl(relay));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/control';
  return url.href;
}

export async function connectControl({ session, role, room = session.room, display, signal, onMessage = () => {}, onClose = () => {} }) {
  const socket = new WebSocket(controlUrl(session.relay));
  let closed = false, lastPong = performance.now(), heartbeat;
  const send = message => {
    if (closed || socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 16384) { close(); return false; }
    socket.send(JSON.stringify(message)); return true;
  };
  const close = () => {
    if (closed) return;
    closed = true; clearInterval(heartbeat);
    if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= 16384) socket.send(JSON.stringify({ t: 'stop' }));
    signal?.removeEventListener('abort', close);
    socket.close(); onClose();
  };
  return new Promise((resolve, reject) => {
    let ready = false;
    const timeout = setTimeout(() => { close(); reject(new Error('Remote-control relay did not respond. Deploy the updated realtime server.')); }, 8000);
    socket.addEventListener('open', () => send({ t: 'hello', role, room, token: session.token, display }));
    socket.addEventListener('message', event => {
      if (closed || typeof event.data !== 'string' || event.data.length > 4096) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.t === 'ready' && !ready) {
        ready = true; clearTimeout(timeout);
        heartbeat = setInterval(() => {
          if (performance.now() - lastPong > 4500) close();
          else send({ t: 'ping' });
        }, 1000);
        resolve({ send, close });
      }
      if (msg.t === 'pong') lastPong = performance.now();
      else onMessage(msg);
    });
    const ended = () => { clearTimeout(timeout); close(); if (!ready) reject(new Error('Remote control unavailable. Check account, channel and relay version.')); };
    socket.addEventListener('error', ended);
    socket.addEventListener('close', ended);
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) { ended(); }
  });
}
