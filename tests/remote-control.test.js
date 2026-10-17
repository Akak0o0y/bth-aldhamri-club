import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { createControlHub, validInput } from '../server/control.js';
import { controlUrl, connectControl } from '../tools/dhamri/control-client.mjs';
import { startControlHost } from '../tools/dhamri/control-host.mjs';
import { createViewer } from '../tools/dhamri/viewer.mjs';
import { sourcePoint } from '../tools/dhamri/viewer/geometry.mjs';
import { settings, parseArgs } from '../tools/dhamri/core.mjs';

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0; out = [];
  send(raw) { this.out.push(JSON.parse(raw)); }
  close() { if (this.readyState !== 1) return; this.readyState = 3; this.emit('close'); }
  receive(msg) { this.emit('message', Buffer.from(JSON.stringify(msg)), false); }
  last(type) { return this.out.filter(m => m.t === type).at(-1); }
}
function hubFixture() {
  let time = 1000;
  const tokens = new Map([['host-token', 'Host'], ['viewer-token', 'Viewer'], ['other-token', 'Other']]);
  const hub = createControlHub({ authenticate: t => tokens.get(t), roomOf: n => n === 'Host' ? 'majlis' : 'other', now: () => time, leaseMs: 10000 });
  const join = (role, token, room = 'majlis') => {
    const ws = new Socket(); hub.attach(ws); ws.receive({ t: 'hello', role, token, room, display: { width: 1920, height: 1080 } }); return ws;
  };
  return { hub, tokens, join, advance(ms) { time += ms; hub.tick(); } };
}
test('control rejects anonymous access and forged host authority', () => {
  const f = hubFixture();
  try {
    assert.equal(f.join('host', 'viewer-token').readyState, 3);
    assert.equal(f.join('viewer', 'bad-token').readyState, 3);
    const host = f.join('host', 'host-token');
    assert.equal(host.last('ready').role, 'host');
    assert.equal(f.join('host', 'host-token').readyState, 3);
  } finally { f.hub.close(); }
});

test('malformed authentication cannot crash the relay or grant control', () => {
  const hub = createControlHub({ authenticate: () => { throw new Error('malformed token'); }, roomOf: () => 'majlis' });
  try {
    const socket = new Socket(); hub.attach(socket);
    assert.doesNotThrow(() => socket.receive({ t: 'hello', role: 'host', room: 'majlis', token: 'invalid' }));
    assert.equal(socket.readyState, 3);
    assert.equal(socket.last('ready'), undefined);
  } finally { hub.close(); }
});
test('only an explicitly approved viewer can send typed input; stale grants cannot be reused', () => {
  const f = hubFixture();
  try {
    const host = f.join('host', 'host-token'), viewer = f.join('viewer', 'viewer-token'), other = f.join('viewer', 'other-token');
    viewer.receive({ t: 'input', event: { kind: 'key', code: 'KeyA', down: true }, seq: 1 });
    assert.equal(host.last('input'), undefined);
    viewer.receive({ t: 'request' }); const request = host.last('request');
    other.receive({ t: 'decision', id: request.id, allow: true });
    host.receive({ t: 'decision', id: 'wrong', allow: true });
    assert.equal(viewer.last('granted'), undefined);
    host.receive({ t: 'decision', id: request.id, allow: true });
    const grant = viewer.last('granted'); assert.ok(grant.session);
    const packet = { t: 'input', session: grant.session, seq: 1, event: { kind: 'key', code: 'KeyA', down: true } };
    other.receive(packet); assert.equal(host.last('input'), undefined);
    viewer.receive(packet); assert.equal(host.last('input').event.code, 'KeyA');
    viewer.receive(packet); assert.match(viewer.last('ended').reason, /invalid/);
    const count = host.out.length; viewer.receive({ ...packet, seq: 2 }); assert.equal(host.out.length, count);
  } finally { f.hub.close(); }
});
test('denial, cross-room requests, revoked accounts and lost heartbeats release sessions', () => {
  const f = hubFixture();
  try {
    const host = f.join('host', 'host-token'), viewer = f.join('viewer', 'viewer-token');
    const elsewhere = f.join('viewer', 'other-token', 'another-room');
    elsewhere.receive({ t: 'request' }); assert.equal(host.last('request'), undefined);
    viewer.receive({ t: 'request' }); host.receive({ t: 'decision', id: host.last('request').id, allow: false });
    assert.equal(viewer.last('granted'), undefined); assert.match(viewer.last('ended').reason, /declined/);
    f.tokens.delete('viewer-token'); viewer.receive({ t: 'ping' }); assert.equal(viewer.readyState, 3);
    f.advance(6000); assert.equal(host.readyState, 3);
  } finally { f.hub.close(); }
});
test('consent expires independently of live heartbeats and disconnect clears ownership', () => {
  const f = hubFixture();
  try {
    const host = f.join('host', 'host-token'), viewer = f.join('viewer', 'viewer-token');
    viewer.receive({ t: 'request' }); host.receive({ t: 'decision', id: host.last('request').id, allow: true });
    for (let i = 0; i < 11; i++) { host.receive({ t: 'ping' }); viewer.receive({ t: 'ping' }); f.advance(1000); }
    assert.match(viewer.last('ended').reason, /expired/);
    viewer.receive({ t: 'request' }); host.receive({ t: 'decision', id: host.last('request').id, allow: true });
    host.close(); assert.equal(viewer.last('state').available, false); assert.match(viewer.last('ended').reason, /disconnected/);
  } finally { f.hub.close(); }
});
test('only finite bounded mouse/keyboard events are accepted', () => {
  for (const e of [{ kind: 'exec', command: 'cmd' }, { kind: 'move', x: -1, y: 0 }, { kind: 'move', x: NaN, y: 0 }, { kind: 'key', code: 'Process', down: true }, { kind: 'button', button: 5, x: 0, y: 0, down: true }, { kind: 'wheel', delta: 1201 }]) assert.equal(validInput(e), false);
  assert.equal(validInput({ kind: 'key', code: 'ControlLeft', down: true }), true);
  assert.equal(validInput({ kind: 'button', button: 0, x: 1, y: 0, down: false }), true);
});
test('mouse coordinates exclude CSS letterboxing and encoded padding', () => {
  const rect = { left: 10, top: 20, width: 1000, height: 800 };
  const display = { width: 1920, height: 1080 };
  assert.deepEqual(sourcePoint(rect, 2560, 1440, display, 510, 420), { x: 0.5, y: 0.5 });
  assert.equal(sourcePoint(rect, 2560, 1440, display, 510, 30), null);
  assert.equal(sourcePoint(rect, 1920, 1080, { width: 1280, height: 1024 }, 15, 420), null);
  assert.equal(sourcePoint(rect, 0, 0, display, 10, 20), null);
});
test('CLI exposes a separate viewer and permits attended control only for desktop capture', () => {
  assert.equal(parseArgs(['watch', '--room', 'majlis', '--control']).command, 'watch');
  assert.equal(settings({ room: 'someone', control: true }, 'watch').room, 'someone');
  for (const options of [{ file: 'video.mp4', 'allow-control': true }, { monitor: '1', 'allow-control': true }, { json: true, 'allow-control': true }, { room: '../private' }, { control: true }]) assert.throws(() => settings(options));
  assert.equal(controlUrl('https://relay.example'), 'wss://relay.example/control');
});

async function localHub() {
  const require = createRequire(new URL('../server/package.json', import.meta.url));
  const { WebSocketServer } = require('ws');
  const server = createServer();
  const hub = createControlHub({ authenticate: token => ({ 'host-unit': 'host', 'viewer-unit': 'viewer' })[token], roomOf: name => name === 'host' ? 'majlis' : 'viewer' });
  const wss = new WebSocketServer({ server }); wss.on('connection', ws => hub.attach(ws));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { relay: `http://127.0.0.1:${server.address().port}`, async close() { hub.close(); for (const ws of wss.clients) ws.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve)); } };
}
const until = async fn => { const end = Date.now() + 5000; while (!fn()) { if (Date.now() > end) throw new Error('Test timed out'); await new Promise(resolve => setTimeout(resolve, 20)); } };
test('real WebSocket control waits for terminal approval and releases on revoke', async () => {
  const relay = await localHub(), input = new PassThrough(), output = new PassThrough(); input.isTTY = true;
  const commands = [], logs = [], viewerEvents = [];
  let host, viewer, helperEvent;
  try {
    host = await startControlHost({ session: { token: 'host-unit', room: 'majlis', relay: relay.relay }, info: { width: 1920, height: 1080 }, input, output, log: s => logs.push(s), helperFactory: async ({ onEvent }) => { helperEvent = onEvent; return { display: { width: 1920, height: 1080 }, send: m => { commands.push(m); return true; }, close() {} }; } });
    viewer = await connectControl({ session: { token: 'viewer-unit', relay: relay.relay }, role: 'viewer', room: 'majlis', onMessage: m => viewerEvents.push(m) });
    viewer.send({ t: 'request' }); await until(() => logs.some(s => /APPROVE /.test(s)));
    assert.equal(commands.some(c => c.t === 'enable'), false);
    const code = /APPROVE ([0-9A-F]+)/.exec(logs.join('\n'))[1]; input.write(`APPROVE ${code}\n`);
    await until(() => commands.some(c => c.t === 'enable'));
    const session = viewerEvents.find(m => m.t === 'granted').session;
    viewer.send({ t: 'input', session, seq: 1, event: { kind: 'key', code: 'KeyA', down: true } });
    await until(() => commands.some(c => c.t === 'input'));
    helperEvent({ t: 'revoked' }); await until(() => viewerEvents.some(m => m.t === 'ended'));
    assert.equal(commands.at(-1).t, 'disable');
  } finally { host?.close(); viewer?.close(); input.destroy(); output.destroy(); await relay.close(); }
});
test('desktop viewer refuses other origins and does not expose account credentials', async () => {
  const relay = await localHub();
  const viewer = await createViewer({ config: { room: 'majlis', server: 'https://media.example' }, session: { token: 'viewer-unit', relay: relay.relay } });
  try {
    const config = await fetch(viewer.url + 'config').then(r => r.text()); assert.doesNotMatch(config, /viewer-unit|token/);
    const response = await fetch(viewer.url + 'commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '[{"t":"request"}]' });
    assert.equal(response.status, 403);
    assert.equal((await fetch(new URL('/config', viewer.url))).status, 404);
    assert.match((await fetch(viewer.url)).headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } finally { await viewer.close(); await relay.close(); }
});

test('backpressure closes control safely without recursion or retaining consent', async () => {
  const f = hubFixture();
  try {
    const host = f.join('host', 'host-token'), viewer = f.join('viewer', 'viewer-token');
    viewer.receive({ t: 'request' }); host.receive({ t: 'decision', id: host.last('request').id, allow: true });
    host.bufferedAmount = 100000;
    viewer.receive({ t: 'input', session: viewer.last('granted').session, seq: 1, event: { kind: 'move', x: 0.5, y: 0.5 } });
    assert.equal(host.readyState, 3);
    assert.equal(viewer.last('state').available, false);
  } finally { f.hub.close(); }
});
