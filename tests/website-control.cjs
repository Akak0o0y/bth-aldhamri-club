// Actual website, synthetic WebRTC media, real local control relay and terminal
// approval. A recording helper receives input; no user desktop is controlled.
const { createServer } = require('node:http');
const { createRequire } = require('node:module');
const { PassThrough } = require('node:stream');
const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
async function main() {
  const { chromium } = require(process.env.MAJLIS_PLAYWRIGHT || 'playwright');
  const { createServer: createVite } = await import('vite');
  const { WebSocketServer } = createRequire(resolve('server/package.json'))('ws');
  const { createControlHub } = await import('../server/control.js');
  const { startControlHost } = await import('../tools/dhamri/control-host.mjs');
  const http = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/login' || req.url === '/api/me') return res.end(JSON.stringify({ name: 'controller', token: 'viewer', owner: false, room: 'viewer' }));
    res.writeHead(404).end('{}');
  });
  const hub = createControlHub({ authenticate: token => ({ host: 'streamer', viewer: 'controller' })[token], roomOf: name => name === 'streamer' ? 'majlis' : 'viewer' });
  const ws = new WebSocketServer({ server: http });
  ws.on('connection', (socket, req) => {
    if (req.url === '/control') hub.attach(socket);
    else socket.on('message', bytes => { const m = JSON.parse(String(bytes)); if (m.t === 'hello') socket.send(JSON.stringify({ t: 'welcome', id: 'fixture', messages: [], votes: {}, myVote: null })); });
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const relay = `http://127.0.0.1:${http.address().port}`;
  const vite = await createVite({ server: { host: '127.0.0.1', port: 0 } }); await vite.listen();
  const input = new PassThrough(), output = new PassThrough(); input.isTTY = true;
  const commands = [], logs = [], errors = [];
  let host, browser;
  try {
    host = await startControlHost({ session: { token: 'host', room: 'majlis', relay }, info: { width: 1920, height: 1080 }, input, output, log: s => logs.push(s), helperFactory: async () => ({ display: { width: 1920, height: 1080 }, send: m => { commands.push(m); return true; }, close() {} }) });
    browser = await chromium.launch({ headless: true, executablePath: process.env.MAJLIS_CHROME, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('majlis.prefs.v1', JSON.stringify({ username: 'test viewer', muted: true, sfx: false })));
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, PATCH, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, if-match', 'Access-Control-Expose-Headers': 'Location' };
    await page.route('http://127.0.0.1:19001/**', async route => {
      const method = route.request().method();
      if (method === 'OPTIONS' || method === 'DELETE') return route.fulfill({ status: 204, headers: cors });
      if (method === 'PATCH') {
        await page.evaluate(async fragment => {
          let mid = '0';
          for (const line of fragment.split('\r\n')) {
            if (line.startsWith('a=mid:')) mid = line.slice(6);
            if (line.startsWith('a=candidate:')) await window.fixturePeer?.addIceCandidate({ candidate: line.slice(2), sdpMid: mid }).catch(() => {});
          }
        }, route.request().postData());
        return route.fulfill({ status: 204, headers: cors });
      }
      const answer = await page.evaluate(async offer => {
        const pc = new RTCPeerConnection(); window.fixturePeer = pc;
        const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
        const ctx = canvas.getContext('2d'); let count = 0;
        window.fixtureTimer = setInterval(() => { ctx.fillStyle = '#182c49'; ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = '#6fe1c0'; ctx.fillRect((count++ * 8) % 1200, 100, 80, 400); }, 25);
        const stream = canvas.captureStream(30); window.fixtureStream = stream;
        await pc.setRemoteDescription({ type: 'offer', sdp: offer }); pc.addTrack(stream.getVideoTracks()[0], stream);
        await pc.setLocalDescription(await pc.createAnswer());
        await new Promise(resolve => { if (pc.iceGatheringState === 'complete') return resolve(); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); }; });
        return pc.localDescription.sdp;
      }, route.request().postData());
      return route.fulfill({ status: 201, headers: { ...cors, 'Content-Type': 'application/sdp', Location: '/session' }, body: answer });
    });
    const url = new URL(vite.resolvedUrls.local[0]); url.searchParams.set('rt', relay.replace('http:', 'ws:')); url.searchParams.set('server', 'http://127.0.0.1:19001');
    await page.goto(url.href);
    await page.waitForFunction(() => document.querySelector('video').videoWidth > 0);
    assert.equal(commands.some(c => c.t === 'enable'), false);
    await page.getByRole('button', { name: 'دخول للتحكم', exact: true }).click();
    await page.locator('#acc-name').fill('controller'); await page.locator('#acc-pass').fill('synthetic-local-password');
    await page.locator('dialog').getByRole('button', { name: 'دخول', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#acc-name'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    const request = page.getByRole('button', { name: 'طلب التحكم', exact: true });
    const approve = async () => {
      await page.waitForFunction(() => [...document.querySelectorAll('.remote-control button')].some(b => b.textContent.includes('طلب التحكم') && !b.disabled));
      const before = logs.length;
      await request.click();
      await page.waitForFunction(() => document.querySelector('.remote-control').textContent.includes('بانتظار'));
      for (let i = 0; i < 100 && !logs.slice(before).some(s => s.includes('APPROVE ')); i++) await page.waitForTimeout(20);
      const code = /APPROVE ([0-9A-F]+)/.exec(logs.slice(before).join('\n'))?.[1]; assert.ok(code);
      const enableCount = commands.filter(c => c.t === 'enable').length;
      await page.waitForTimeout(100); assert.equal(commands.filter(c => c.t === 'enable').length, enableCount);
      input.write(`APPROVE ${code}\n`);
      await page.waitForFunction(() => document.querySelector('.remote-control.is-active'));
    };
    await approve();
    await page.locator('video').click({ position: { x: 350, y: 200 } });
    await page.keyboard.type('afkm'); await page.mouse.wheel(0, 120); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.querySelector('video').paused), false, 'K must reach remote laptop without pausing local player');
    assert.equal(await page.evaluate(() => Boolean(document.fullscreenElement)), false, 'F must not toggle fullscreen while controlling');
    assert.ok(commands.some(c => c.t === 'input' && c.event.kind === 'key' && c.event.code === 'KeyK'));
    assert.ok(commands.some(c => c.t === 'input' && c.event.kind === 'button' && c.event.down));
    assert.ok(commands.some(c => c.t === 'input' && c.event.kind === 'wheel'));
    const beforeChat = commands.filter(c => c.t === 'input' && c.event.kind === 'key').length;
    await page.locator('.composer input, .composer textarea').fill('local chat'); await page.waitForTimeout(100);
    assert.equal(commands.filter(c => c.t === 'input' && c.event.kind === 'key').length, beforeChat);
    const screenshot = join(tmpdir(), 'dhamri-website-control.png'); await page.screenshot({ path: screenshot, fullPage: true });
    await page.getByRole('button', { name: 'ملء الشاشة (F)', exact: true }).click();
    await page.waitForFunction(() => Boolean(document.fullscreenElement));
    assert.equal(await page.locator('.remote-control__stop').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), true, 'stop control must remain visible in fullscreen');
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('.remote-control.is-active'));
    await page.evaluate(() => document.fullscreenElement && document.exitFullscreen());
    await page.waitForTimeout(100); assert.equal(commands.at(-1).t, 'disable');
    await approve();
    await page.keyboard.down('Shift'); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.keyboard.up('Shift');
    await page.waitForFunction(() => !document.querySelector('.remote-control.is-active'));
    await approve();
    await page.evaluate(() => document.querySelector('video').pause());
    await page.waitForFunction(() => !document.querySelector('.remote-control.is-active'));
    await page.waitForTimeout(100); assert.equal(commands.at(-1).t, 'disable');
    await page.evaluate(() => document.querySelector('video').play());
    await approve();
    await page.getByRole('button', { name: 'إيقاف التحكم', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.remote-control.is-active'));
    await approve();
    await page.getByRole('button', { name: 'حسابي: controller', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.remote-control.is-active'));
    await page.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('dialog[open]'));
    assert.equal(await page.getByRole('button', { name: 'دخول للتحكم', exact: true }).isVisible(), true);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'mobile page must not overflow');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', signIn: 'website account form', consent: 'fresh native approval each session', input: 'mouse, keyboard, scroll; player shortcuts and chat isolated', release: 'Escape, blur, playback pause, stop button, account dialog and sign-out', fullscreen: 'stop button remains visible', mobileOverflow: false, screenshot }, null, 2));
  } finally {
    await browser?.close(); host?.close(); input.destroy(); output.destroy(); hub.close();
    for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => http.close(resolve)); await vite.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
