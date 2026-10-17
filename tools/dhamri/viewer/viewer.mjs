import { sourcePoint } from './geometry.mjs';
const $ = id => document.getElementById(id);
const video = $('video'), request = $('request'), stopButton = $('stop');
const config = await fetch('config').then(r => r.json());
$('room').textContent = config.room;
request.hidden = !config.control;
let session = '', display, sequence = 0, available = false, busy = false, pending = false, peer, resource, retry, closing = false;
let queue = [], sending = false;
async function flush() {
  if (sending || !queue.length || closing) return;
  sending = true;
  const batch = queue.splice(0, 32);
  try {
    const response = await fetch('commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batch), signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error('local connection');
  } catch { failControl('Viewer connection lost. Reopen dhamri watch.'); }
  finally { sending = false; if (queue.length) flush(); }
}
function send(msg) {
  if (closing) return;
  if (msg.t === 'input' && msg.event.kind === 'move' && queue.at(-1)?.event?.kind === 'move') queue.pop();
  if (queue.length >= 64) { queue = [{ t: 'stop' }]; end('Control stopped: input queue is too slow.'); }
  else queue.push(msg);
  flush();
}
function end(reason = 'Control stopped. Request again when ready.') {
  session = ''; pending = false; document.body.classList.remove('controlling'); stopButton.hidden = true;
  $('control-status').textContent = reason; updateButton();
}
function stop(reason) { queue = queue.filter(m => m.t !== 'input'); send({ t: 'stop' }); end(reason); }
function updateButton() { request.disabled = closing || !available || busy || pending || Boolean(session) || !peer || peer.connectionState !== 'connected' || video.paused || !video.videoWidth; }
// Desktop capture omits duplicate frames. An idle desktop must remain clickable;
// use transport health and the host heartbeat, not frame cadence, for liveness.
function input(event) { if (session && document.hasFocus() && !document.hidden && !video.paused && peer?.connectionState === 'connected') send({ t: 'input', session, seq: ++sequence, event }); }
function failControl(reason) {
  closing = true; queue = []; clearTimeout(retry); end(reason);
  // Closing SSE immediately asks the local process to revoke control. Stopping
  // browser heartbeats also closes the local process if that close is delayed.
  events.close(); disconnect();
}
const events = new EventSource('events');
events.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.t === 'state') { available = msg.available; busy = msg.busy; display = msg.display; if (!session && !pending) $('control-status').textContent = available ? (busy ? 'Streamer is handling another control session.' : 'Control available. The streamer must approve your request.') : 'View only — streamer has not enabled control.'; }
  else if (msg.t === 'pending') { pending = true; $('control-status').textContent = 'Waiting for the streamer to approve in their terminal…'; }
  else if (msg.t === 'granted') {
    if (!pending || document.hidden || !document.hasFocus()) { stop('Control stopped because the viewer lost focus.'); return; }
    session = msg.session; display = msg.display; pending = false; sequence = 0;
    document.body.classList.add('controlling'); stopButton.hidden = false; video.focus();
    $('control-status').textContent = 'CONTROL ACTIVE — mouse and keyboard are shared. Esc stops control. Switching windows also stops it.';
  } else if (msg.t === 'ended' || msg.t === 'error') { if (msg.t === 'error') available = false; end(msg.message || msg.reason); }
  else if (msg.t === 'shutdown') { closing = true; stop('Viewer closed.'); events.close(); disconnect(); window.close(); }
  updateButton();
};
events.onerror = () => failControl('Control connection closed. Reopen the viewer.');
request.onclick = () => { pending = true; updateButton(); $('control-status').textContent = 'Requesting permission…'; send({ t: 'request' }); };
stopButton.onclick = () => stop();
$('sound').onclick = () => { video.muted = !video.muted; $('sound').textContent = video.muted ? 'Enable sound' : 'Mute'; video.play().catch(() => {}); };
$('fullscreen').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
video.addEventListener('contextmenu', event => { if (session) event.preventDefault(); });
const point = event => sourcePoint(video.getBoundingClientRect(), video.videoWidth, video.videoHeight, display, event.clientX, event.clientY);
let lastMove = 0;
video.addEventListener('pointermove', event => { if (!session || performance.now() - lastMove < 16) return; const p = point(event); if (p) { lastMove = performance.now(); input({ kind: 'move', ...p }); } });
video.addEventListener('pointerdown', event => { const p = point(event); if (!session || !p || event.button > 2) return; event.preventDefault(); video.focus(); video.setPointerCapture(event.pointerId); input({ kind: 'button', button: event.button, down: true, ...p }); });
video.addEventListener('pointerup', event => { if (!session) return; event.preventDefault(); const p = point(event); if (p) input({ kind: 'button', button: event.button, down: false, ...p }); else input({ kind: 'reset' }); });
video.addEventListener('pointercancel', () => input({ kind: 'reset' }));
video.addEventListener('wheel', event => { if (!session) return; event.preventDefault(); input({ kind: 'wheel', delta: -Math.sign(event.deltaY) * 120 }); }, { passive: false });
const keys = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Arrow(Up|Down|Left|Right)|Enter|Escape|Backspace|Tab|Space|Delete|Insert|Home|End|PageUp|PageDown|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Meta(Left|Right)|CapsLock|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash)$/;
for (const type of ['keydown', 'keyup']) video.addEventListener(type, event => {
  if (!session) return;
  if (event.code === 'Escape') { event.preventDefault(); stop(); return; }
  if (keys.test(event.code)) { event.preventDefault(); input({ kind: 'key', code: event.code, down: type === 'keydown' }); }
});
video.addEventListener('blur', () => { if (session) send({ t: 'input', session, seq: ++sequence, event: { kind: 'reset' } }); });
video.addEventListener('pause', () => { if (session || pending) stop('Control stopped because playback paused.'); });
video.addEventListener('ended', () => { if (session || pending) stop('Control stopped because playback ended.'); });
video.addEventListener('playing', updateButton);
addEventListener('blur', () => { if (session || pending) stop('Control stopped because the viewer lost focus.'); });
document.addEventListener('visibilitychange', () => { if (document.hidden && (session || pending)) stop('Control stopped because the viewer is hidden.'); });
setInterval(() => send({ t: 'ping' }), 1000);

async function disconnect() {
  peer?.close(); peer = null;
  if (resource) { const url = resource; resource = null; await fetch(url, { method: 'DELETE', keepalive: true }).catch(() => {}); }
}
async function connect() {
  await disconnect(); if (closing) return;
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], bundlePolicy: 'max-bundle' }); peer = pc;
  pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('audio', { direction: 'recvonly' });
  const stream = new MediaStream(); video.srcObject = stream;
  pc.ontrack = event => { stream.addTrack(event.track); try { event.receiver.jitterBufferTarget = 100; } catch { /* optional */ } video.play().catch(() => {}); };
  pc.onconnectionstatechange = () => {
    updateButton();
    if (pc.connectionState === 'connected') { $('video-status').hidden = true; return; }
    if (session || pending) stop('Control stopped because the stream disconnected.');
    if (['failed', 'disconnected'].includes(pc.connectionState)) { clearTimeout(retry); retry = setTimeout(connect, 3000); }
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(resolve => { if (pc.iceGatheringState === 'complete') return resolve(); const timeout = setTimeout(resolve, 2000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); } }; });
    const endpoint = `${config.server}/${encodeURIComponent(config.room)}/whep`;
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp, signal: AbortSignal.timeout(10000) });
    if (response.status !== 201) throw new Error(response.status === 400 ? 'The stream could not negotiate playback. For HEVC, use compatible hardware or ask the streamer to use H.264.' : `Stream is unavailable (HTTP ${response.status}). Waiting for the broadcaster…`);
    const location = response.headers.get('location');
    if (!location) throw new Error('Server omitted its viewing session.');
    const sessionUrl = new URL(location, endpoint);
    if (sessionUrl.origin !== new URL(config.server).origin) throw new Error('Invalid stream session location.');
    if (closing || peer !== pc) { await fetch(sessionUrl, { method: 'DELETE', keepalive: true }).catch(() => {}); return; }
    resource = sessionUrl.href;
    await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
  } catch (error) { if (closing) return; $('video-status').hidden = false; $('video-status').textContent = error.message; clearTimeout(retry); retry = setTimeout(connect, 3000); }
}
setInterval(async () => {
  if (!peer || peer.connectionState !== 'connected') return;
  try { const stats = await peer.getStats(); const v = [...stats.values()].find(s => s.type === 'inbound-rtp' && s.kind === 'video'); if (v) $('stats').textContent = `${v.frameWidth || '?'}×${v.frameHeight || '?'} · ${v.framesPerSecond ?? '?'} fps · ${stats.get(v.codecId)?.mimeType?.split('/')[1] || ''}`; } catch { /* connection changed */ }
}, 1000);
addEventListener('beforeunload', () => {
  closing = true; clearTimeout(retry); events.close();
  fetch('commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[{"t":"stop"}]', keepalive: true }).catch(() => {});
  disconnect();
});
connect();
