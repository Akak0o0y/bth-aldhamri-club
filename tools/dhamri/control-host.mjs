import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { connectControl } from './control-client.mjs';

export function launchInputHelper({ onEvent = () => {}, binary = fileURLToPath(new URL('./bin/dhamri-input.exe', import.meta.url)) } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let ready = false, closed = false, buffer = '';
    const send = msg => {
      if (closed || child.stdin.destroyed || child.stdin.writableLength > 16384) return false;
      child.stdin.write(JSON.stringify(msg) + '\n'); return true;
    };
    const close = () => { if (!closed) child.stdin.end(); };
    const timeout = setTimeout(() => { close(); reject(new Error('Windows control helper did not start.')); }, 5000);
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {});
    child.stdout.on('data', bytes => {
      buffer += bytes;
      if (buffer.length > 16384) { close(); return; }
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.t === 'ready' && !ready) { ready = true; clearTimeout(timeout); resolve({ send, close, display: event.display }); }
        if (event.t === 'error' && !ready) { clearTimeout(timeout); reject(new Error(event.message)); close(); }
        onEvent(event);
      }
    });
    child.on('error', () => { clearTimeout(timeout); reject(new Error('Input helper missing. Download the new Windows release ZIP.')); });
    child.on('close', () => { closed = true; clearTimeout(timeout); if (!ready) reject(new Error('Windows control helper failed to start.')); onEvent({ t: 'closed' }); });
  });
}

export async function startControlHost({ session, info, signal, log = console.log, input = process.stdin, output = process.stdout, helperFactory = launchInputHelper }) {
  if (!input.isTTY) throw new Error('--allow-control requires an interactive terminal for local approval.');
  let connection, helper, pending, active, alive = performance.now(), closed = false;
  const clear = () => { pending = null; active = null; helper?.send({ t: 'disable' }); };
  const stop = () => { connection?.send({ t: 'stop' }); clear(); };
  const rl = createInterface({ input, output, terminal: false });
  rl.on('line', line => {
    if (line.trim().toUpperCase() === 'STOP') { stop(); return; }
    if (!pending || Date.now() > pending.expires) return;
    if (line.trim() === `APPROVE ${pending.code}`) {
      pending.approved = true;
      connection?.send({ t: 'decision', id: pending.id, allow: true });
    } else if (line.trim().toUpperCase() === 'DENY') { connection?.send({ t: 'decision', id: pending.id, allow: false }); pending = null; }
  });
  rl.on('close', stop);
  const close = () => {
    if (closed) return;
    closed = true; clearInterval(watchdog); signal?.removeEventListener('abort', close);
    stop(); connection?.close(); helper?.close(); rl.close();
  };
  const watchdog = setInterval(() => {
    if (pending && Date.now() > pending.expires) { connection?.send({ t: 'stop' }); pending = null; }
    if (active && performance.now() - alive > 3000) { log('Remote control stopped: viewer heartbeat lost.'); stop(); }
  }, 250);
  try {
    helper = await helperFactory({ onEvent: msg => {
      if (msg.t === 'revoked' || msg.t === 'closed' || msg.t === 'error') { log('Remote control stopped on this laptop.'); stop(); }
      if (msg.t === 'closed' || msg.t === 'error') connection?.close();
    } });
    if (helper.display.width !== info.width || helper.display.height !== info.height) throw new Error('Capture and control display dimensions differ. Use the laptop screen with external displays disconnected.');
    connection = await connectControl({ session, role: 'host', display: helper.display, signal, onClose: clear, onMessage: msg => {
      if (closed) return;
      if (msg.t === 'request') {
        clear();
        const code = randomBytes(3).toString('hex').toUpperCase();
        pending = { id: msg.id, code, expires: Date.now() + 30000, approved: false };
        const name = [...String(msg.name)].filter(c => c.codePointAt(0) >= 32 && (c.codePointAt(0) < 127 || c.codePointAt(0) > 159)).join('').slice(0, 64);
        log(`\nREMOTE CONTROL REQUEST from signed-in account: ${name}\nThey will control your mouse and keyboard for up to 10 minutes.\nType APPROVE ${code} and Enter within 30 seconds, or DENY.\nSTOP + Enter or Ctrl+Alt+F10 revokes control.\n`);
      } else if (msg.t === 'granted') {
        if (!pending?.approved || Date.now() > pending.expires) { stop(); return; }
        pending = null; active = msg.session; alive = performance.now();
        if (!helper.send({ t: 'enable', session: active })) { stop(); return; }
        log('REMOTE CONTROL ACTIVE. Ctrl+Alt+F10 or the Stop control window revokes it.');
      } else if (msg.t === 'alive' && msg.session === active) {
        alive = performance.now(); helper.send({ t: 'heartbeat', session: active });
      } else if (msg.t === 'input' && msg.session === active) {
        if (!helper.send({ t: 'input', session: active, event: msg.event })) stop();
      } else if (msg.t === 'ended') { log(`Remote control ended: ${msg.reason}.`); clear(); }
    } });
    if (signal?.aborted) close(); else signal?.addEventListener('abort', close, { once: true });
    log('Remote-control requests enabled. Every session requires your approval in this terminal.');
    return { close };
  } catch (error) { close(); throw error; }
}
