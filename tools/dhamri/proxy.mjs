import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { secureUrl, tailscaleIp } from './core.mjs';

// FFmpeg's WHIP implementation uses UDP. Select a UDP candidate explicitly;
// the upstream answer can also contain TCP candidates for browser clients.
export function prepareAnswer(sdp, peer) {
  if (peer) tailscaleIp(peer);
  const lines = sdp.split(/\r?\n/);
  const candidates = lines.filter(line => /^a=candidate:\S+ \d+ udp /i.test(line));
  if (!candidates.length) throw new Error('The media server advertised no UDP candidate. Native WHIP needs UDP.');
  const first = candidates.find(line => /^a=candidate:\S+ \d+ udp \d+ \d+\.\d+\.\d+\.\d+ /i.test(line)) || candidates[0];
  const fields = first.split(' ');
  if (peer) fields[4] = peer;
  const selected = fields.join(' ');
  return lines.map(line => /^a=candidate:/i.test(line) ? (/ udp /i.test(line) ? selected : null) : line)
    .filter(line => line !== null).join('\r\n');
}

async function bodyBytes(request) {
  const chunks = [];
  let count = 0;
  for await (const chunk of request) {
    count += chunk.length;
    if (count > 65536) throw new Error('Signaling request too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function createWhipProxy({ endpoint, token, tailscalePeer, onStatus = () => {} }) {
  const target = new URL(endpoint);
  secureUrl(target.origin);
  const nonce = randomBytes(24).toString('hex');
  let resource = null, busy = false, closing = false;
  const controllers = new Set();
  const pending = new Set();
  const upstream = async (url, options = {}) => {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, {
        ...options, redirect: 'error', signal: controller.signal,
        headers: { ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body || []) {
        size += chunk.length;
        if (size > 65536) { controller.abort(); throw new Error('Signaling response too large.'); }
        chunks.push(chunk);
      }
      return { status: response.status, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') };
    } finally { clearTimeout(timer); controllers.delete(controller); }
  };
  const deleteResource = async () => {
    if (!resource) return;
    const url = resource;
    resource = null;
    await upstream(url, { method: 'DELETE' }).catch(() => {});
  };
  let localOrigin;
  const handle = async (req, res) => {
    // Loopback only, unguessable per-run URL, no browser origin or CORS access.
    if (closing || req.headers.origin || req.headers.host !== localOrigin?.slice(7)) {
      res.writeHead(403).end(); return;
    }
    const publish = req.url === `/${nonce}/whip` && req.method === 'POST';
    const remove = req.url === `/${nonce}/session` && req.method === 'DELETE';
    if (!publish && !remove) { res.writeHead(404).end(); return; }
    if (remove) { await deleteResource(); res.writeHead(200, { 'Content-Length': '0', Connection: 'close' }).end(); return; }
    if (busy || resource) { res.writeHead(409).end(); return; }
    busy = true;
    try {
      if (req.headers['content-type']?.split(';')[0] !== 'application/sdp') { res.writeHead(415).end(); return; }
      const body = await bodyBytes(req);
      const response = await upstream(target, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body });
      if (response.status !== 201) {
        onStatus(`WHIP rejected the stream (HTTP ${response.status}). ${response.status === 401 ? 'Run dhamri login again.' : 'Check that this channel is not already broadcasting.'}`);
        res.writeHead(response.status >= 400 ? response.status : 502).end();
        return;
      }
      const location = response.headers.get('location');
      if (!location) throw new Error('WHIP response has no session location.');
      const session = new URL(location, target);
      if (session.origin !== target.origin || session.username || session.password) throw new Error('Refusing a cross-origin WHIP session location.');
      resource = session;
      const answer = response.body;
      if (answer.length > 65536 || !answer.startsWith('v=0')) throw new Error('Invalid WHIP SDP response.');
      const prepared = prepareAnswer(answer, tailscalePeer);
      // FFmpeg's WHIP reader needs an explicit body length; a chunked 201 can
      // fail at EOF even though a browser fetch accepts the same response.
      res.writeHead(201, { 'Content-Type': 'application/sdp', 'Content-Length': Buffer.byteLength(prepared), Connection: 'close', Location: `${localOrigin}/${nonce}/session` }).end(prepared);
      onStatus(tailscalePeer ? `Signaling accepted. UDP media directed to the server's Tailscale IP ${tailscalePeer}.` : 'Signaling accepted. Establishing encrypted UDP media.');
    } catch {
      await deleteResource();
      onStatus('WHIP signaling failed. Check the server URL, certificate, UDP availability, and account.');
      if (!res.headersSent) res.writeHead(502);
      res.end();
    } finally { busy = false; }
  };
  const server = createServer((req, res) => {
    const task = handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(502); res.end(); });
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  localOrigin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${localOrigin}/${nonce}/whip`,
    async close() {
      closing = true;
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      const stopped = new Promise(resolve => server.close(resolve));
      await Promise.allSettled([...pending]);
      await deleteResource();
      await stopped;
    },
  };
}
