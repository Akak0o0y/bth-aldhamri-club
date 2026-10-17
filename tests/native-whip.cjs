// Optional real media integration test; no production services or credentials.
// Set DHAMRI_MEDIAMTX, MAJLIS_PLAYWRIGHT and optionally MAJLIS_CHROME.
const { spawn } = require('node:child_process');
const { mkdtemp, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');

async function main() {
  const { chromium } = require(process.env.MAJLIS_PLAYWRIGHT || 'playwright');
  const { settings, ffmpegArgs } = await import('../tools/dhamri/core.mjs');
  const { createWhipProxy } = await import('../tools/dhamri/proxy.mjs');
  const { run } = await import('../tools/dhamri/process.mjs');
  const { startHevcBridge } = await import('../tools/dhamri/bridge.mjs');
  const { saveSession } = await import('../tools/dhamri/auth.mjs');
  const { createViewer } = await import('../tools/dhamri/viewer.mjs');
  const codec = process.env.DHAMRI_CODEC || 'h264';
  const audioTest = process.env.DHAMRI_AUDIO_TEST === '1';
  const cliTest = process.env.DHAMRI_CLI_TEST === '1';
  const desktopViewerTest = process.env.DHAMRI_DESKTOP_VIEWER === '1';
  if (!process.env.DHAMRI_MEDIAMTX) throw new Error('Set DHAMRI_MEDIAMTX to a local MediaMTX executable.');
  const directory = await mkdtemp(join(tmpdir(), 'dhamri-whip-'));
  const configPath = join(directory, 'mediamtx.yml');
  await writeFile(configPath, `logLevel: warn
api: true
apiAddress: 127.0.0.1:19997
rtsp: false
rtmp: false
hls: false
srt: false
moq: false
webrtcAddress: 127.0.0.1:18889
webrtcLocalUDPAddress: 127.0.0.1:18189
webrtcLocalTCPAddress: ''
webrtcIPsFromInterfaces: false
webrtcAdditionalHosts: [127.0.0.1]
paths:
  native-test:
`);
  const server = spawn(process.env.DHAMRI_MEDIAMTX, [configPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', b => { serverLog = (serverLog + b).slice(-4000); });
  server.stderr.on('data', b => { serverLog = (serverLog + b).slice(-4000); });
  const pageServer = createServer((_req, res) => res.setHeader('Content-Type', 'text/html').end('<video autoplay muted playsinline style="width:640px;height:360px"></video>'));
  await new Promise(resolve => pageServer.listen(0, '127.0.0.1', resolve));
  let browser, proxy, publisher, bridge, authServer, viewer;
  const previousAppData = process.env.LOCALAPPDATA;
  const controller = new AbortController();
  try {
    for (let i = 0; i < 40; i++) {
      if (server.exitCode !== null) throw new Error(`MediaMTX failed: ${serverLog}`);
      try { const r = await fetch('http://127.0.0.1:18889/native-test/whip', { method: 'OPTIONS' }); if (r.ok) break; } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!cliTest) proxy = await createWhipProxy({ endpoint: 'http://127.0.0.1:18889/native-test/whip', token: '', onStatus: console.log });
    const config = settings({ source: 'test', seconds: '35', codec, ...(audioTest ? { audio: 'generated-test-tone' } : {}) });
    const samples = [];
    if (codec === 'hevc' && !cliTest) bridge = await startHevcBridge({ endpoint: proxy.url, audio: audioTest, signal: controller.signal, onFailure: error => { console.error(error.message); controller.abort(); } });
    const args = ffmpegArgs(config, process.env.DHAMRI_ENCODER || 'amf', { endpoint: bridge ? undefined : proxy?.url, rtp: bridge });
    if (audioTest) {
      args[args.indexOf('dshow')] = 'lavfi';
      args.splice(args.indexOf('-audio_buffer_size'), 2);
      args[args.indexOf('audio=generated-test-tone')] = 'sine=frequency=440:sample_rate=48000';
    }
    if (cliTest) {
      const videoFile = join(directory, 'sample with audio & spaces.mkv');
      // Generate a local fixture; then exercise the actual file/ffprobe/login path.
      args.splice(args.indexOf('-readrate'), 4);
      args.splice(args.lastIndexOf('-f'), 3, '-f', 'matroska', videoFile);
      const fixture = await run(process.env.MAJLIS_FFMPEG || 'ffmpeg', args, { timeout: 60000 });
      assert.equal(fixture.code, 0, 'video fixture must encode');
      authServer = createServer((req, res) => {
        if (req.url !== '/api/me' || req.headers.authorization !== 'Bearer synthetic-local-integration-token') { res.writeHead(401).end(); return; }
        res.setHeader('Content-Type', 'application/json').end(JSON.stringify({ name: 'integration-user', room: 'native-test' }));
      });
      await new Promise(resolve => authServer.listen(0, '127.0.0.1', resolve));
      process.env.LOCALAPPDATA = directory;
      await saveSession({ name: 'integration-user', room: 'native-test', token: 'synthetic-local-integration-token' }, { relay: `http://127.0.0.1:${authServer.address().port}`, server: 'http://127.0.0.1:18889' });
      const cli = process.env.DHAMRI_CLI_ENTRY || resolve('tools/dhamri/cli.mjs');
      publisher = run(process.execPath, [cli, 'start', '--codec', codec, '--encoder', process.env.DHAMRI_ENCODER || 'amf', '--file', videoFile, '--seconds', '25'], { timeout: 50000, signal: controller.signal });
    } else publisher = run(process.env.MAJLIS_FFMPEG || 'ffmpeg', args, { timeout: 50000, signal: controller.signal, onProgress: sample => samples.push(sample) });
    let early;
    publisher.then(result => { early = result; });
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      if (early) throw new Error(`Publisher exited before media: ${early.stderr}`);
      const paths = await fetch('http://127.0.0.1:19997/v3/paths/list').then(r => r.json());
      ready = paths.items?.some(path => path.name === 'native-test' && path.ready);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'publisher was not ready on the media server within 15 seconds');
    browser = await chromium.launch({ headless: true, executablePath: process.env.MAJLIS_CHROME, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage();
    page.on('pageerror', error => console.error('Viewer script error:', error.message));
    page.on('console', message => { if (message.type() === 'error') console.error('Viewer console:', message.text()); });
    if (desktopViewerTest) {
      viewer = await createViewer({ config: { room: 'native-test', server: 'http://127.0.0.1:18889' } });
      await page.addInitScript(() => {
        const Peer = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Peer { constructor(...args) { super(...args); window.testPeer = this; } };
      });
    }
    await page.goto(viewer?.url || `http://127.0.0.1:${pageServer.address().port}`);
    if (desktopViewerTest) {
      try { await page.waitForFunction(() => window.testPeer?.connectionState === 'connected' && document.querySelector('video').videoWidth > 0, null, { timeout: 20000 }); }
      catch (error) {
        console.error('Viewer playback state:', await page.evaluate(async () => ({ status: document.querySelector('#video-status').textContent, connection: window.testPeer?.connectionState, videoWidth: document.querySelector('video').videoWidth, stats: window.testPeer ? [...(await window.testPeer.getStats()).values()].filter(s => s.type === 'inbound-rtp' || s.type === 'codec') : [] })));
        throw error;
      }
    }
    const measurements = await page.evaluate(async ({ audioTest, desktopViewerTest }) => {
      const video = document.querySelector('video');
      const pc = desktopViewerTest ? window.testPeer : new RTCPeerConnection();
      window.testPeer = pc;
      if (!desktopViewerTest) {
      pc.addTransceiver('video', { direction: 'recvonly' });
      if (audioTest) pc.addTransceiver('audio', { direction: 'recvonly' });
      const stream = new MediaStream();
      video.srcObject = stream;
      pc.ontrack = event => { stream.addTrack(event.track); video.play().catch(() => {}); };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise(resolve => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const timeout = setTimeout(resolve, 2000);
        pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timeout); resolve(); } };
      });
      const response = await fetch('http://127.0.0.1:18889/native-test/whep', { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
      if (response.status !== 201) throw new Error(`WHEP HTTP ${response.status}`);
      window.whepResource = new URL(response.headers.get('location'), 'http://127.0.0.1:18889/native-test/whep').href;
      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
      }
      const rows = [];
      for (let i = 0; i < 16; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const stats = await pc.getStats();
        const inbound = [...stats.values()].find(s => s.type === 'inbound-rtp' && s.kind === 'video');
        const audio = [...stats.values()].find(s => s.type === 'inbound-rtp' && s.kind === 'audio');
        if (inbound) rows.push({ at: performance.now(), width: inbound.frameWidth, height: inbound.frameHeight, decoded: inbound.framesDecoded, dropped: inbound.framesDropped, fps: inbound.framesPerSecond, codec: stats.get(inbound.codecId)?.mimeType, rendered: video.getVideoPlaybackQuality().totalVideoFrames, freezes: inbound.freezeCount, audioSamples: audio?.totalSamplesReceived || 0 });
      }
      if (!desktopViewerTest) { await fetch(window.whepResource, { method: 'DELETE' }).catch(() => {}); pc.close(); }
      return rows;
    }, { audioTest, desktopViewerTest });
    const warm = measurements.slice(5);
    assert.ok(warm.length >= 8, 'not enough decoded samples');
    assert.ok(warm.every(s => s.width === 2560 && s.height === 1440), 'decoded dimensions must remain 2560x1440');
    assert.ok(warm.every(s => s.codec === (codec === 'hevc' ? 'video/H265' : 'video/H264')), 'receiver must decode the selected codec');
    const first = warm[0], last = warm.at(-1);
    const decodedFps = (last.decoded - first.decoded) * 1000 / (last.at - first.at);
    assert.ok(last.rendered > first.rendered, 'video element must actually render');
    if (audioTest) assert.ok(last.audioSamples > first.audioSamples, 'Opus audio must be decoded');
    console.log(JSON.stringify({ decodedFps: Math.round(decodedFps * 10) / 10, width: last.width, height: last.height, codec: last.codec, framesDropped: last.dropped, freezes: last.freezes, minimumReportedFps: Math.min(...warm.map(s => s.fps || 0)), audioSamples: last.audioSamples, viewer: desktopViewerTest ? 'Dhamri desktop viewer UI' : 'minimal test receiver', scope: 'Local synthetic native WHIP -> MediaMTX -> headless Chrome. Not an internet or 8 GB laptop result.' }, null, 2));
    if (viewer) {
      await page.goto('about:blank');
      await viewer.close(); viewer = null;
    }
    // The CLI owns an FFmpeg child; let its --seconds deadline perform normal
    // cleanup instead of killing the parent process and orphaning the encoder.
    if (!cliTest) controller.abort();
    const published = await publisher;
    if (cliTest) assert.equal(published.code, 0, `CLI must finish successfully: ${published.stderr}`);
    await bridge?.close();
    await proxy?.close();
    proxy = null;
    const sessions = await fetch('http://127.0.0.1:19997/v3/webrtcsessions/list').then(r => r.json());
    assert.equal(sessions.items.length, 0, 'WHIP/WHEP sessions must be removed');
    console.log('PASS: real native WHIP playback and session cleanup.');
  } finally {
    if (!cliTest) controller.abort();
    if (publisher) { const result = await publisher; if (result.code !== 0 && !result.cancelled) console.error(result.stderr); }
    await bridge?.close();
    if (serverLog) console.log(serverLog);
    await proxy?.close();
    await browser?.close();
    await viewer?.close();
    pageServer.closeAllConnections();
    await new Promise(resolve => pageServer.close(resolve));
    if (authServer) { authServer.closeAllConnections(); await new Promise(resolve => authServer.close(resolve)); }
    process.env.LOCALAPPDATA = previousAppData;
    server.kill();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
