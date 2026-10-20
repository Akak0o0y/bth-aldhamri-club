// Exercise the actual relay's hold notice with an isolated temporary account DB.
// Needs the server's dependencies: npm ci --prefix server
const { spawn } = require('node:child_process');
const { mkdtemp } = require('node:fs/promises');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function client(url, hello) {
  const ws = new WebSocket(url);
  const events = [];
  ws.onmessage = (e) => events.push(JSON.parse(e.data));
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => { ws.send(JSON.stringify({ t: 'hello', ...hello })); resolve(); };
    ws.onerror = reject;
  });
  return { ws, events, ready, send: (msg) => ws.send(JSON.stringify(msg)) };
}

async function until(check) {
  for (let i = 0; i < 80; i++) {
    const found = check();
    if (found) return found;
    await delay(25);
  }
  return null;
}

async function main() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const directory = await mkdtemp(join(tmpdir(), 'dhamri-hold-relay-test-'));
  const server = spawn(process.execPath, ['server/realtime.js'], {
    windowsHide: true,
    stdio: 'pipe',
    env: { ...process.env, DATA_DIR: directory, PORT: String(port), ADMIN_USER: 'hold-test-admin', ADMIN_PASS: 'synthetic-local-test-password', AUTH_SECRET: 'synthetic-local-test-secret-0123456789', MTX_AUTH_KEY: '', ALLOWED_ORIGINS: '' },
  });
  let logs = '';
  server.stdout.on('data', (b) => { logs = (logs + b).slice(-2000); });
  server.stderr.on('data', (b) => { logs = (logs + b).slice(-2000); });
  const relay = `http://127.0.0.1:${port}`;
  const socket = `ws://127.0.0.1:${port}`;
  const sockets = [];
  try {
    for (let i = 0; i < 50; i++) {
      if (server.exitCode !== null) throw new Error(logs);
      try { await fetch(relay); break; } catch { await delay(100); }
    }
    const login = await fetch(`${relay}/api/login`, { method: 'POST', body: JSON.stringify({ name: 'hold-test-admin', pass: 'synthetic-local-test-password' }) });
    const owner = await login.json();
    assert.equal(login.status, 200);

    const viewer = client(socket, { room: owner.room, id: 'viewer01', name: 'viewer' });
    const impostor = client(socket, { room: owner.room, id: 'impost01', name: 'impostor', host: true });
    const host = client(socket, { room: owner.room, id: 'hostdev1', name: 'host', host: true });
    sockets.push(viewer, impostor, host);
    await Promise.all(sockets.map((c) => c.ready));
    await until(() => sockets.every((c) => c.events.some((m) => m.t === 'init')));
    assert.equal(viewer.events.find((m) => m.t === 'init').hold, null);

    // Claiming host is not enough: no token, or someone else's channel.
    impostor.send({ t: 'hold', on: true, elapsed: 0, note: 'fake' });
    await delay(150);
    assert.equal(viewer.events.some((m) => m.t === 'hold'), false);

    host.send({ t: 'hold', on: true, elapsed: 30000, note: 'نرجع بعد شوي', token: owner.token });
    const held = await until(() => viewer.events.find((m) => m.t === 'hold'));
    assert.equal(held.hold.note, 'نرجع بعد شوي');
    // The relay dates the hold from the elapsed time, on its own clock.
    assert.ok(Math.abs(held.now - held.hold.since - 30000) < 1000);

    const late = client(socket, { room: owner.room, id: 'latecom1', name: 'late' });
    sockets.push(late);
    await late.ready;
    const init = await until(() => late.events.find((m) => m.t === 'init'));
    assert.equal(init.hold.note, 'نرجع بعد شوي');

    // A dropped streamer socket (phone locked) keeps the hold for the grace period.
    host.ws.close();
    await delay(150);
    const after = client(socket, { room: owner.room, id: 'after001', name: 'after' });
    sockets.push(after);
    await after.ready;
    assert.equal((await until(() => after.events.find((m) => m.t === 'init'))).hold.note, 'نرجع بعد شوي');

    const back = client(socket, { room: owner.room, id: 'hostdev1', name: 'host', host: true });
    sockets.push(back);
    await back.ready;
    await until(() => back.events.some((m) => m.t === 'init'));
    back.send({ t: 'hold', on: false, token: owner.token });
    const resumed = await until(() => viewer.events.find((m) => m.t === 'hold' && m.hold === null));
    assert.equal(resumed.ended, false);

    // Ending the broadcast mid-hold tells viewers it ended, not that it is back.
    back.send({ t: 'hold', on: true, elapsed: 0, note: '', token: owner.token });
    await until(() => viewer.events.filter((m) => m.t === 'hold' && m.hold).length === 2);
    back.send({ t: 'hold', on: false, ended: true, token: owner.token });
    const ended = await until(() => viewer.events.filter((m) => m.t === 'hold' && m.hold === null)[1]);
    assert.equal(ended.ended, true);
    console.log('PASS: relay hold notice needs the channel owner\'s token, reaches viewers and late joiners, survives a dropped streamer socket, and tells continue apart from ending.');
  } finally {
    for (const c of sockets) c.ws.close();
    server.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
