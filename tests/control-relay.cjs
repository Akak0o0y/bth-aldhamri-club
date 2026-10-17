// Exercise the actual server entry point with an isolated temporary account DB.
const { spawn } = require('node:child_process');
const { mkdtemp } = require('node:fs/promises');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const { connectControl } = await import('../tools/dhamri/control-client.mjs');
  const portProbe = createServer(); await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), 'dhamri-control-relay-test-'));
  const server = spawn(process.execPath, ['server/realtime.js'], { windowsHide: true, stdio: 'pipe', env: { ...process.env, DATA_DIR: directory, PORT: String(port), ADMIN_USER: 'control-test-admin', ADMIN_PASS: 'synthetic-local-test-password', AUTH_SECRET: 'synthetic-local-test-secret-0123456789', MTX_AUTH_KEY: '', ALLOWED_ORIGINS: 'https://dhamri.vercel.app' } });
  let logs = ''; server.stdout.on('data', b => { logs = (logs + b).slice(-2000); }); server.stderr.on('data', b => { logs = (logs + b).slice(-2000); });
  let host, viewer;
  const relay = `http://127.0.0.1:${port}`;
  async function api(path, body, token) {
    const response = await fetch(relay + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal(response.status, 200); return response.json();
  }
  try {
    for (let i = 0; i < 50; i++) { if (server.exitCode !== null) throw new Error(logs); try { await fetch(relay); break; } catch { await delay(100); } }
    assert.equal((await api('/')).controlProtocol, 1);
    const owner = await api('/api/login', { name: 'control-test-admin', pass: 'synthetic-local-test-password' });
    const invite = await api('/api/invites', {}, owner.token);
    const controller = await api('/api/register', { code: invite.code, name: 'control-test-viewer', pass: 'synthetic-other-password' });
    const hostEvents = [], viewerEvents = [];
    host = await connectControl({ session: { ...owner, relay }, role: 'host', display: { width: 1920, height: 1080 }, onMessage: m => hostEvents.push(m) });
    viewer = await connectControl({ session: { ...controller, relay }, role: 'viewer', room: owner.room, onMessage: m => viewerEvents.push(m) });
    viewer.send({ t: 'request' });
    for (let i = 0; i < 40 && !hostEvents.some(m => m.t === 'request'); i++) await delay(25);
    host.send({ t: 'decision', id: hostEvents.find(m => m.t === 'request').id, allow: true });
    for (let i = 0; i < 40 && !viewerEvents.some(m => m.t === 'granted'); i++) await delay(25);
    const session = viewerEvents.find(m => m.t === 'granted').session;
    // Cross the existing chat socket's 25-second heartbeat boundary.
    await delay(27000);
    viewer.send({ t: 'input', session, seq: 1, event: { kind: 'key', code: 'KeyA', down: true } });
    await delay(100);
    assert.ok(hostEvents.some(m => m.t === 'input'));
    await api('/api/password', { current: 'synthetic-other-password', pass: 'replacement-local-password' }, controller.token);
    for (let i = 0; i < 80 && !hostEvents.some(m => m.t === 'ended'); i++) await delay(25);
    assert.ok(hostEvents.some(m => m.t === 'ended'));
    console.log('PASS: actual relay login, cross-account approval, 27-second live session, typed input, password-change revocation. No OS input or production accounts used.');
  } finally { host?.close(); viewer?.close(); server.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
