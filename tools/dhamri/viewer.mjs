import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, mkdtemp, access, rm, realpath } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { connectControl } from './control-client.mjs';

// HTTP is loopback-only. A per-launch capability URL and exact Origin/Host
// checks keep arbitrary web pages from issuing control commands. The account
// token stays in Node and is never returned to the viewer or put on argv.
export async function createViewer({ config, session, onClose = () => {} }) {
  const secret = randomBytes(24).toString('hex');
  const assets = new Map();
  for (const name of ['index.html', 'viewer.mjs', 'viewer.css', 'geometry.mjs']) assets.set(name, await readFile(new URL(`./viewer/${name}`, import.meta.url)));
  let origin, events, connection, active = '', closed = false, lastBrowser = performance.now(), attached = false;
  const history = [];
  const event = msg => {
    if (msg.t === 'granted') active = msg.session;
    if (msg.t === 'ended') active = '';
    if (events && !events.destroyed) {
      if (!events.write(`data: ${JSON.stringify(msg)}\n\n`)) { stop(); events.destroy(); }
    } else { history.push(msg); if (history.length > 16) history.shift(); }
  };
  const stop = () => { active = ''; connection?.send({ t: 'stop' }); };
  const server = createServer(async (req, res) => {
    try {
      if (closed || req.headers.host !== origin?.slice(7) || (req.headers.origin && req.headers.origin !== origin)) { res.writeHead(403).end(); return; }
      const url = new URL(req.url, origin);
      if (!url.pathname.startsWith(`/${secret}/`) || url.search) { res.writeHead(404).end(); return; }
      const route = url.pathname.slice(secret.length + 2);
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${new URL(config.server).origin}; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'`);
      if (req.method === 'GET' && assets.has(route || 'index.html')) {
        const name = route || 'index.html';
        res.setHeader('Content-Type', name.endsWith('.mjs') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
        res.end(assets.get(name)); return;
      }
      if (req.method === 'GET' && route === 'config') {
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ room: config.room, server: config.server, control: Boolean(session) })); return;
      }
      if (req.method === 'GET' && route === 'events') {
        if (events) { res.writeHead(409).end(); return; }
        events = res; attached = true; lastBrowser = performance.now();
        res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' }); res.write(': ready\n\n');
        for (const msg of history.splice(0)) event(msg);
        res.on('close', () => { if (events === res) { events = null; stop(); } }); return;
      }
      if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json' || route !== 'commands') { res.writeHead(403).end(); return; }
      let size = 0, raw = '';
      for await (const bytes of req) { size += bytes.length; if (size > 8192) { res.writeHead(413).end(); req.destroy(); return; } raw += bytes; }
      const messages = JSON.parse(raw);
      if (!Array.isArray(messages) || messages.length > 32) { res.writeHead(400).end(); return; }
      for (const msg of messages) {
        if (!msg || typeof msg !== 'object') continue;
        if (msg.t === 'ping') lastBrowser = performance.now();
        else if (msg.t === 'stop') stop();
        else if (msg.t === 'request') connection?.send({ t: 'request' });
        else if (msg.t === 'input' && active && msg.session === active) connection?.send(msg);
      }
      res.writeHead(204).end();
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const close = async () => {
    if (closed) return; event({ t: 'shutdown' }); closed = true; clearInterval(timer);
    stop(); connection?.close(); events?.end(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); onClose();
  };
  const timer = setInterval(() => {
    if (performance.now() - lastBrowser > (attached ? 3500 : 60000)) close();
  }, 500);
  if (session) {
    try {
      connection = await connectControl({ session, role: 'viewer', room: config.room, onMessage: event, onClose: () => event({ t: 'ended', reason: 'control connection closed; reopen the viewer to reconnect' }) });
    } catch (error) { event({ t: 'error', message: error.message }); }
  }
  return { url: `${origin}/${secret}/`, close };
}

export async function launchViewer(options) {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const candidates = roots.flatMap(root => [join(root, 'Microsoft/Edge/Application/msedge.exe'), join(root, 'Google/Chrome/Application/chrome.exe')]);
  let browser;
  for (const path of candidates) { try { await access(path); browser = path; break; } catch { /* next installed browser */ } }
  if (!browser) throw new Error('The desktop viewer needs Microsoft Edge or Google Chrome installed.');
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const viewer = await createViewer({ ...options, onClose: finish });
  // A separate temporary profile avoids modifying the user's browser profile.
  const profile = await mkdtemp(join(tmpdir(), 'dhamri-viewer-'));
  const child = spawn(browser, [`--app=${viewer.url}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--autoplay-policy=no-user-gesture-required', '--window-size=1280,820'], { shell: false, windowsHide: true, stdio: 'ignore' });
  child.once('error', () => viewer.close());
  const stop = () => viewer.close();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  console.log(`Dhamri desktop viewer: ${options.config.room}. Close the viewer or press Ctrl+C to stop.`);
  try { await done; } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop); await viewer.close(); child.kill();
    // Delete only the exact temporary profile created by this launch.
    const root = await realpath(tmpdir());
    const owned = await realpath(profile);
    if (dirname(owned) === root && basename(owned).startsWith('dhamri-viewer-')) await rm(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}
