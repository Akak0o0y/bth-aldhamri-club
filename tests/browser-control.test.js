import test from 'node:test';
import assert from 'node:assert/strict';
import { controlEndpoint, createBrowserControl } from '../src/control/client.js';
import { trustedRelay } from '../src/realtime/trustedRelay.js';

class Socket extends EventTarget {
  readyState = 0; bufferedAmount = 0; sent = [];
  send(raw) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  receive(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
}
function fixture() {
  let time = 1000, allowed = true;
  const socket = new Socket(), states = [];
  const client = createBrowserControl({ url: 'wss://relay.example/control', room: 'majlis', token: 'unit-token', canControl: () => allowed, onState: s => states.push(s), socketFactory: () => socket, now: () => time });
  const ready = () => { socket.open(); socket.receive({ t: 'ready' }); socket.receive({ t: 'state', available: true, busy: false, display: { width: 1920, height: 1080 } }); };
  const grant = () => socket.receive({ t: 'granted', session: 'a'.repeat(32), expires: time + 10000, display: { width: 1920, height: 1080 } });
  return { client, socket, states, ready, grant, allow: value => { allowed = value; }, advance: ms => { time += ms; }, pong: () => socket.receive({ t: 'pong' }) };
}
test('browser control only sends account credentials to its trusted relay or local development server', () => {
  const config = { pageUrl: 'https://dhamri.vercel.app/', trustedRelay: 'wss://relay.example' };
  assert.equal(controlEndpoint('wss://relay.example', config), 'wss://relay.example/control');
  for (const value of ['wss://other.example', 'ws://relay.example', 'wss://user:pass@relay.example', 'wss://relay.example?token=secret', 'wss://relay.example/#fragment', 'ws://localhost:8787']) assert.throws(() => controlEndpoint(value, config));
  assert.equal(controlEndpoint('ws://127.0.0.1:8787', { ...config, pageUrl: 'http://localhost:5173' }), 'ws://127.0.0.1:8787/control');
  assert.equal(trustedRelay('wss://relay.example', config).replace(/^ws/, 'http'), 'https://relay.example');
  assert.throws(() => trustedRelay('wss://attacker.example', config));
});
test('browser requires a current request and host grant before sending sequenced input', () => {
  const f = fixture();
  try {
    f.client.stop('context'); assert.equal(f.client.get().phase, 'connecting');
    f.ready();
    assert.equal(f.socket.sent[0].token, 'unit-token');
    assert.equal(f.client.input({ kind: 'key', code: 'KeyA', down: true }), false);
    f.grant(); assert.equal(f.client.get().phase, 'ready');
    assert.equal(f.client.request(), true); f.grant();
    assert.equal(f.client.get().phase, 'active');
    f.client.input({ kind: 'key', code: 'KeyA', down: true });
    f.client.input({ kind: 'reset' });
    assert.deepEqual(f.socket.sent.filter(m => m.t === 'input').map(m => m.seq), [1, 2]);
    f.client.stop(); assert.equal(f.client.get().phase, 'ready');
    assert.equal(f.socket.sent.at(-1).t, 'stop');
    assert.equal(f.client.input({ kind: 'move', x: 0.5, y: 0.5 }), false);
  } finally { f.client.close(); }
});
test('cancelled or unfocused requests reject late grants; denial never enables input', () => {
  const f = fixture();
  try {
    f.ready(); f.client.request(); f.client.stop(); f.socket.receive({ t: 'pending' }); f.grant();
    assert.notEqual(f.client.get().phase, 'active');
    f.advance(5100); f.pong(); f.client.tick();
    f.client.request(); f.allow(false); f.grant();
    assert.notEqual(f.client.get().phase, 'active');
    assert.equal(f.socket.sent.at(-1).t, 'stop');
    f.socket.receive({ t: 'ended', reason: 'request declined or expired' });
    assert.equal(f.client.get().reason, 'declined');
  } finally { f.client.close(); }
});
test('blur, playback loss, expiry and missing heartbeats revoke browser control', () => {
  const f = fixture();
  try {
    f.ready(); f.client.request(); f.grant();
    f.allow(false); f.client.tick(); assert.equal(f.client.get().phase, 'ready');
    f.allow(true); f.advance(5100); f.pong(); f.client.tick(); f.client.request(); f.grant();
    f.advance(10001); f.pong(); f.client.tick(); assert.equal(f.client.get().reason, 'expired');
    f.advance(5000); f.client.tick(); assert.equal(f.client.get().phase, 'closed');
    assert.equal(f.socket.readyState, 3);
  } finally { f.client.close(); }
});
test('backpressure and teardown never retain approval or reuse a session', () => {
  const f = fixture();
  try {
    f.ready(); f.client.request(); f.grant();
    f.socket.bufferedAmount = 20000;
    assert.equal(f.client.input({ kind: 'key', code: 'KeyA', down: true }), false);
    assert.equal(f.client.get().phase, 'closed');
    f.grant(); assert.equal(f.client.get().phase, 'closed');
  } finally { f.client.close(); }
});

test('browser restrictions on creating a socket become a recoverable connection error', () => {
  let state;
  const client = createBrowserControl({ url: 'wss://relay.example/control', room: 'majlis', token: 'unit-token', canControl: () => true, onState: s => { state = s; }, socketFactory: () => { throw new Error('blocked by browser'); } });
  assert.equal(state.phase, 'closed');
  assert.equal(client.request(), false);
  assert.doesNotThrow(() => client.close());
});
