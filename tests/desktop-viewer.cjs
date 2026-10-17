// Real isolated viewer UI + WebRTC frames + authenticated WebSocket relay.
// Input uses a recording sink; this test never controls the user's desktop.
const { createServer } = require('node:http');
const { createRequire } = require('node:module');
const { PassThrough } = require('node:stream');
const { resolve, join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

async function main() {
  const { chromium } = require(process.env.MAJLIS_PLAYWRIGHT || 'playwright');
  const serverRequire = createRequire(resolve('server/package.json'));
  const { WebSocketServer } = serverRequire('ws');
  const { createControlHub } = await import('../server/control.js');
  const { startControlHost } = await import('../tools/dhamri/control-host.mjs');
  const { createViewer } = await import('../tools/dhamri/viewer.mjs');
  const http = createServer();
  const hub = createControlHub({ authenticate: token => ({ host: 'streamer', viewer: 'controller' })[token], roomOf: name => name === 'streamer' ? 'majlis' : 'viewer' });
  const ws = new WebSocketServer({ server: http }); ws.on('connection', socket => hub.attach(socket));
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const relay = `http://127.0.0.1:${http.address().port}`;
  const input = new PassThrough(), output = new PassThrough(); input.isTTY = true;
  const commands = [], logs = [], errors = [];
  let host, viewer, browser;
  try {
    host = await startControlHost({ session: { token: 'host', room: 'majlis', relay }, info: { width: 1920, height: 1080 }, input, output, log: s => logs.push(s), helperFactory: async () => ({ display: { width: 1920, height: 1080 }, send: m => { commands.push(m); return true; }, close() {} }) });
    viewer = await createViewer({ config: { room: 'majlis', server: 'http://127.0.0.1:19001' }, session: { token: 'viewer', relay } });
    browser = await chromium.launch({ headless: true, executablePath: process.env.MAJLIS_CHROME, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1:19001/**', async route => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, DELETE', 'Access-Control-Allow-Headers': 'content-type' } });
      if (route.request().method() === 'DELETE') return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
      const answer = await page.evaluate(async offer => {
        const pc = new RTCPeerConnection(); window.fixturePeer = pc;
        const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
        const ctx = canvas.getContext('2d'); let count = 0;
        window.fixtureTimer = setInterval(() => { ctx.fillStyle = '#182c49'; ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = '#6fe1c0'; ctx.fillRect((count++ * 8) % 1200, 100, 80, 400); }, 25);
        const stream = canvas.captureStream(30); window.fixtureStream = stream;
        await pc.setRemoteDescription({ type: 'offer', sdp: offer });
        pc.addTrack(stream.getVideoTracks()[0], stream);
        await pc.setLocalDescription(await pc.createAnswer());
        await new Promise(resolve => { if (pc.iceGatheringState === 'complete') return resolve(); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve(); }; });
        return pc.localDescription.sdp;
      }, route.request().postData());
      await route.fulfill({ status: 201, headers: { 'Content-Type': 'application/sdp', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Location', Location: '/session' }, body: answer });
    });
    await page.goto(viewer.url);
    await page.waitForFunction(() => document.querySelector('video').videoWidth > 0 && !document.querySelector('#request').disabled);
    await page.locator('#request').click();
    await page.waitForFunction(() => document.querySelector('#control-status').textContent.includes('approve'));
    assert.equal(commands.some(c => c.t === 'enable'), false);
    const code = /APPROVE ([0-9A-F]+)/.exec(logs.join('\n'))[1];
    input.write(`APPROVE ${code}\n`);
    await page.waitForFunction(() => document.body.classList.contains('controlling'));
    await page.locator('video').click({ position: { x: 600, y: 350 } });
    await page.keyboard.press('a');
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(150);
    assert.ok(commands.some(c => c.t === 'input' && c.event.kind === 'button' && c.event.down));
    assert.ok(commands.some(c => c.t === 'input' && c.event.kind === 'key' && c.event.code === 'KeyA'));
    assert.ok(commands.some(c => c.t === 'input' && c.event.kind === 'wheel'));
    // ddagrab omits duplicate frames: a static desktop still needs clicks.
    await page.evaluate(() => clearInterval(window.fixtureTimer));
    await page.waitForTimeout(2500);
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('controlling')), true);
    const idleCommands = commands.length;
    await page.keyboard.press('b');
    await page.waitForTimeout(100);
    assert.ok(commands.slice(idleCommands).some(c => c.t === 'input' && c.event.kind === 'key' && c.event.code === 'KeyB'));
    const screenshot = join(tmpdir(), 'dhamri-desktop-viewer-control.png');
    await page.screenshot({ path: screenshot });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.body.classList.contains('controlling'));
    await page.waitForTimeout(100);
    assert.equal(commands.at(-1).t, 'disable');
    const approveAgain = async () => {
      await page.waitForTimeout(5100); // relay's per-viewer request cooldown
      const previous = logs.length;
      await page.locator('#request').click();
      for (let i = 0; i < 100 && !logs.slice(previous).some(s => s.includes('APPROVE ')); i++) await page.waitForTimeout(20);
      const nextCode = /APPROVE ([0-9A-F]+)/.exec(logs.slice(previous).join('\n'))?.[1];
      assert.ok(nextCode, 'fresh local approval must be requested');
      input.write(`APPROVE ${nextCode}\n`);
      await page.waitForFunction(() => document.body.classList.contains('controlling'));
    };
    await approveAgain();
    await page.keyboard.down('Shift');
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.keyboard.up('Shift');
    await page.waitForFunction(() => !document.body.classList.contains('controlling'));
    await page.waitForTimeout(100);
    assert.equal(commands.at(-1).t, 'disable');
    await approveAgain();
    const priorDisableCount = commands.filter(c => c.t === 'disable').length;
    await page.route('**/commands', route => route.abort());
    await page.keyboard.press('a');
    await page.waitForFunction(() => !document.body.classList.contains('controlling'));
    for (let i = 0; i < 100 && commands.filter(c => c.t === 'disable').length === priorDisableCount; i++) await page.waitForTimeout(20);
    assert.ok(commands.filter(c => c.t === 'disable').length > priorDisableCount, 'failed local transport must revoke input, including held keys');
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ result: 'PASS', video: 'actual WebRTC frames rendered', approval: 'required each time', mouseKeyboardWheel: 'relayed to recording helper, including on a still desktop', escapeBlurAndFailedTransport: 'released control', errors, screenshot }, null, 2));
  } finally {
    await browser?.close(); await viewer?.close(); host?.close(); input.destroy(); output.destroy(); hub.close();
    for (const socket of ws.clients) socket.terminate();
    await new Promise(resolve => ws.close(resolve)); await new Promise(resolve => http.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
