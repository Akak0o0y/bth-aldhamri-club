import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, settings, hevcLevel, ffmpegArgs, summarize, secureUrl, tailscaleIp } from '../tools/dhamri/core.mjs';
import { createWhipProxy, prepareAnswer } from '../tools/dhamri/proxy.mjs';
import { loginRequest, protect, saveSession, loadSession, sessionPath } from '../tools/dhamri/auth.mjs';
import { run, failureDetail } from '../tools/dhamri/process.mjs';

const answer = 'v=0\r\na=ice-pwd:not-a-real-credential\r\na=candidate:1 1 tcp 212 192.0.2.1 8189 typ host tcptype passive\r\na=candidate:2 1 udp 213 192.0.2.1 8189 typ host\r\n';

async function serve(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('CLI validates options before capture and never accepts passwords on argv', () => {
  assert.deepEqual(parseArgs(['benchmark', '--fps', '60', '--json']), { command: 'benchmark', options: { fps: '60', json: true } });
  for (const args of [['start', '--password', 'secret'], ['start', '--fps'], ['start', '--fps', '60', '--fps', '120'], ['start', '--unknown']]) assert.throws(() => parseArgs(args));
  for (const options of [{ fps: 'NaN' }, { bitrate: '0' }, { size: '2561x1440' }, { source: 'camera' }, { encoder: 'invented' }, { source: 'file' }, { file: 'x.mp4', audio: 'mic' }]) assert.throws(() => settings(options));
  assert.equal(settings({}, 'benchmark').source, 'test');
  assert.equal(settings({}).source, 'desktop');
  assert.equal(settings({}).fps, 60);
});

test('credentials require verified HTTPS; Tailscale route accepts only a tailnet IPv4', () => {
  assert.equal(secureUrl('https://media.example/'), 'https://media.example');
  assert.equal(secureUrl('http://127.0.0.1:8889'), 'http://127.0.0.1:8889');
  for (const url of ['http://public.example', 'https://user:pass@media.example', 'https://media.example/?token=secret', 'file:///x']) assert.throws(() => secureUrl(url));
  assert.equal(tailscaleIp('100.70.80.90'), '100.70.80.90');
  for (const ip of ['127.0.0.1', '100.1.2.3', '100.128.0.1', '100.70.80.999', 'server; whoami']) assert.throws(() => tailscaleIp(ip));
});

test('native capture avoids duplicate frame padding and converts full RGB to limited BT.709', () => {
  const args = ffmpegArgs(settings({}), 'amf', { endpoint: 'http://127.0.0.1/nonce/whip' });
  assert.match(args[args.indexOf('-i') + 1], /dup_frames=0.*hwdownload,format=bgra/);
  assert.match(args[args.indexOf('-vf') + 1], /out_color_matrix=bt709:out_range=tv:in_range=pc/);
  assert.equal(args[args.indexOf('-bf') + 1], '0');
  assert.equal(args[args.indexOf('-fps_mode') + 1], 'passthrough');
  assert.equal(args[args.indexOf('-profile:v') + 1], 'constrained_baseline');
  assert.ok(!args.includes('-r'));
  assert.ok(!args.includes('-authorization'));
  assert.equal(args[args.indexOf('-pkt_size') + 1], '1200');
  const file = 'C:\\Videos\\a & b $(x).mp4';
  const fileArgs = ffmpegArgs(settings({ file }), 'nvenc');
  assert.equal(fileArgs[fileArgs.indexOf('-i') + 1], file);
  assert.ok(fileArgs.includes('0:a:0?'));
  assert.equal(fileArgs[fileArgs.indexOf('-fps_mode') + 1], 'passthrough');
  assert.ok(!fileArgs.includes('-fpsmax'));
  assert.match(fileArgs[fileArgs.indexOf('-vf') + 1], /select=.*prev_selected_t/);
});

test('HEVC uses main-profile hardware encoding and separate loopback RTP for Opus', () => {
  const config = settings({ codec: 'hevc', audio: 'Stereo Mix' });
  assert.equal(config.bitrate, 12000);
  const args = ffmpegArgs(config, 'amf', { rtp: { videoPort: 42000, audioPort: 42002 } });
  assert.equal(args[args.indexOf('-c:v') + 1], 'hevc_amf');
  assert.equal(args[args.indexOf('-profile:v') + 1], 'main');
  assert.ok(args.includes('rtp://127.0.0.1:42000?pkt_size=1100'));
  assert.ok(args.includes('rtp://127.0.0.1:42002?pkt_size=1100'));
  assert.ok(args.includes('1:a:0'));
  assert.ok(args.includes('libopus'));
  assert.ok(!args.includes('whip'));
  assert.throws(() => ffmpegArgs(config, 'amf', { endpoint: 'http://127.0.0.1/whip' }), /HEVC requires/);
  assert.throws(() => settings({ codec: 'av1' }), /--codec/);
  assert.equal(hevcLevel(config), 150);
  assert.equal(hevcLevel(settings({ size: '3840x2160', fps: '60' })), 153);
  assert.equal(hevcLevel(settings({ size: '3840x2160', fps: '120' })), 156);
});

test('benchmark cannot pass from requested FPS, missing samples, drops, duplicates, or failure', () => {
  const config = settings({}, 'benchmark');
  const samples = Array.from({ length: 21 }, (_, elapsed) => ({ elapsed, frame: elapsed * 60, fps: 60, drop_frames: 0, dup_frames: 0 }));
  assert.equal(summarize(samples, config).passed, true);
  assert.equal(summarize([], config).passed, false);
  assert.equal(summarize(samples.slice(0, 6), config).passed, false);
  assert.equal(summarize(samples.map(s => ({ ...s, frame: s.elapsed * 30 })), config).passed, false);
  assert.equal(summarize(samples.map(s => ({ ...s, dup_frames: 5 })), config).passed, false);
  assert.equal(summarize(samples.map(s => ({ ...s, drop_frames: 1 })), config).passed, false);
  assert.equal(summarize(samples, config, { exitCode: 1 }).passed, false);
  assert.equal(summarize(samples, config, { cancelled: true }).passed, false);
});

test('native WHIP selects UDP and can explicitly route media through a Tailscale server', () => {
  const normal = prepareAnswer(answer);
  assert.doesNotMatch(normal, / tcp /);
  assert.match(normal, / udp 213 192.0.2.1 8189 typ host/);
  const tailnet = prepareAnswer(answer, '100.70.80.90');
  assert.match(tailnet, / udp 213 100.70.80.90 8189 typ host/);
  assert.throws(() => prepareAnswer('v=0\r\na=candidate:1 1 tcp 212 192.0.2.1 8189 typ host\r\n'), /no UDP/);
});

test('signaling proxy keeps tokens out of child URLs, refuses browser requests and deletes sessions', async () => {
  const requests = [];
  const upstream = await serve(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    requests.push({ method: req.method, path: req.url, token: req.headers.authorization, body });
    if (req.method === 'POST') res.writeHead(201, { 'Content-Type': 'application/sdp', Location: '/room/whip/session1' }).end(answer);
    else res.writeHead(200).end();
  });
  const proxy = await createWhipProxy({ endpoint: `${upstream.url}/room/whip?session=test`, token: 'unit-token' });
  try {
    assert.ok(!proxy.url.includes('unit-token'));
    assert.equal((await fetch(proxy.url, { method: 'POST', headers: { Origin: 'https://malicious.example', 'Content-Type': 'application/sdp' }, body: 'v=0' })).status, 403);
    assert.equal((await fetch(proxy.url.replace('/whip', '/other'), { method: 'POST' })).status, 404);
    const response = await fetch(proxy.url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0\r\n' });
    assert.equal(response.status, 201);
    assert.ok(response.headers.get('location').startsWith(new URL(proxy.url).origin));
    assert.doesNotMatch(await response.text(), / tcp /);
    assert.equal(requests[0].token, 'Bearer unit-token');
    assert.equal(requests[0].path, '/room/whip?session=test');
    assert.equal((await fetch(proxy.url, { method: 'POST' })).status, 409);
  } finally { await proxy.close(); await upstream.close(); }
  assert.equal(requests.filter(r => r.method === 'DELETE').length, 1);
  assert.equal(requests.at(-1).token, 'Bearer unit-token');
});

test('proxy rejects cross-origin locations and upstream redirects without forwarding credentials', async () => {
  let otherCalls = 0;
  const other = await serve((_req, res) => { otherCalls++; res.end(); });
  for (const status of [201, 307]) {
    const upstream = await serve((_req, res) => res.writeHead(status, { Location: `${other.url}/steal` }).end(answer));
    const proxy = await createWhipProxy({ endpoint: `${upstream.url}/room/whip`, token: 'unit-token' });
    try {
      const response = await fetch(proxy.url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0' });
      assert.equal(response.status, 502);
    } finally { await proxy.close(); await upstream.close(); }
  }
  await other.close();
  assert.equal(otherCalls, 0);
});

test('bad SDP is cleaned up and upstream error bodies do not leak into local logs', async () => {
  const logs = [];
  let deleted = 0;
  const upstream = await serve((req, res) => {
    if (req.method === 'DELETE') { deleted++; res.end(); }
    else res.writeHead(201, { Location: '/session' }).end('secret upstream response');
  });
  const proxy = await createWhipProxy({ endpoint: `${upstream.url}/room/whip`, token: 'unit-token', onStatus: message => logs.push(message) });
  try {
    const response = await fetch(proxy.url, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: 'v=0' });
    assert.equal(response.status, 502);
    assert.equal(deleted, 1);
    assert.doesNotMatch(logs.join(' '), /secret upstream response|unit-token/);
  } finally { await proxy.close(); await upstream.close(); }
});

test('login uses the existing account API, validates the room, and rejects bad credentials', async () => {
  const upstream = await serve(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(req.url, '/api/login');
    const data = JSON.parse(body);
    if (data.pass !== 'unit-pass') res.writeHead(401).end('{}');
    else res.setHeader('Content-Type', 'application/json').end(JSON.stringify({ name: data.name, room: 'my-channel', token: 'unit-token' }));
  });
  try {
    assert.equal((await loginRequest(upstream.url, 'tester', 'unit-pass')).room, 'my-channel');
    await assert.rejects(loginRequest(upstream.url, 'tester', 'wrong'), /Login failed/);
  } finally { await upstream.close(); }
});

test('process execution preserves metacharacters as literal arguments and times out a stuck child', async () => {
  const argument = 'a & b $(whoami) "quoted"';
  const result = await run(process.execPath, ['-e', 'console.log(process.argv[1])', argument]);
  assert.equal(result.stdout.trim(), argument);
  assert.equal(result.code, 0);
  const stuck = await run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 50 });
  assert.equal(stuck.timedOut, true);
  assert.doesNotMatch(failureDetail({ code: 1, stderr: 'a=ice-pwd:unit-secret\n' }), /unit-secret/);
});

test('Windows DPAPI protects tokens for the current user without exposing the token in arguments', { skip: process.platform !== 'win32' }, async () => {
  const previous = process.env.PSExecutionPolicyPreference;
  process.env.PSExecutionPolicyPreference = 'Restricted';
  try {
    const ciphertext = await protect('synthetic-unit-token', 'protect');
    assert.ok(!ciphertext.includes('synthetic-unit-token'));
    assert.equal(await protect(ciphertext, 'unprotect'), 'synthetic-unit-token');
  } finally {
    if (previous === undefined) delete process.env.PSExecutionPolicyPreference;
    else process.env.PSExecutionPolicyPreference = previous;
  }
});

test('saved login binds credentials to the selected servers and refreshes the authorized room', { skip: process.platform !== 'win32' }, async () => {
  const previous = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = await mkdtemp(join(tmpdir(), 'dhamri-auth-unit-'));
  let calls = 0;
  const relay = await serve((req, res) => {
    calls++;
    assert.equal(req.headers.authorization, 'Bearer synthetic-unit-session');
    assert.equal(req.url, '/api/me');
    res.setHeader('Content-Type', 'application/json').end(JSON.stringify({ name: 'test-user', room: 'authorized-room' }));
  });
  try {
    await saveSession({ name: 'test-user', room: 'old-room', token: 'synthetic-unit-session' }, { relay: relay.url, server: 'https://media.example' });
    assert.doesNotMatch(await readFile(sessionPath(), 'utf8'), /synthetic-unit-session/);
    await assert.rejects(loadSession({ server: 'https://different.example' }), /different server/);
    assert.equal(calls, 0);
    assert.equal((await loadSession({})).room, 'authorized-room');
    assert.equal(calls, 1);
  } finally {
    await relay.close();
    process.env.LOCALAPPDATA = previous;
  }
});

test('real FFmpeg keeps 30/60 fps and caps 120 fps without duplicating frames', { skip: !process.env.DHAMRI_FFMPEG_TEST }, async () => {
  for (const rate of [30, 60, 120]) {
    const config = settings({ file: 'synthetic-fixture', size: '640x360', seconds: '10', encoder: 'software' });
    const args = ffmpegArgs(config, 'software');
    const input = args.indexOf('-readrate');
    // Model local video timestamps rounded to milliseconds, as in Matroska.
    args.splice(input, 6, '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=${rate},settb=1/1000`);
    let last;
    const result = await run(process.env.DHAMRI_FFMPEG_TEST, args, { timeout: 15000, onProgress: sample => { last = sample; } });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(Math.abs(last.frame - Math.min(rate, 60) * 10) <= 1, `${rate} fps input produced ${last.frame} frames`);
    assert.equal(last.dup_frames, 0);
  }
});
