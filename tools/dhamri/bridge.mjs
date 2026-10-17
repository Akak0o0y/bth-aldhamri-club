import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function startHevcBridge({ endpoint, audio, level = 150, signal, binary, onFailure = () => {} }) {
  binary ||= fileURLToPath(new URL('./bin/dhamri-whip.exe', import.meta.url));
  try { await access(binary); } catch { throw new Error('HEVC bridge is missing. Use the Windows release ZIP or build it with tools/dhamri/build-native.cmd.'); }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, ['--url', endpoint, '--level', String(level), ...(audio ? ['--audio'] : [])], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let pending = '', message = '', ready = false, stopping = false, closed = false, killTimer;
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const stop = () => {
      if (closed) return done;
      if (!stopping) {
        stopping = true;
        child.stdin.end('q\n');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      }
      return done;
    };
    const timer = setTimeout(() => { message = 'HEVC bridge connection timed out.'; stop(); }, 35000);
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); };
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {}); // Library logs can contain network identifiers.
    child.stdout.on('data', chunk => {
      pending += chunk.toString();
      if (pending.length > 16384) { message = 'Invalid bridge response.'; stop(); return; }
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.event === 'error') message = String(event.message).slice(0, 300);
        if (event.event === 'ready' && !ready && !stopping) {
          const validPort = value => Number.isInteger(value) && value > 0 && value <= 65535;
          if (!validPort(event.videoPort) || (audio && !validPort(event.audioPort))) { message = 'Invalid bridge ports.'; stop(); continue; }
          ready = true;
          clearTimeout(timer);
          resolve({ videoPort: event.videoPort, audioPort: event.audioPort, close: stop, done });
        }
      }
    });
    child.on('error', () => { cleanup(); finish(); reject(new Error('Could not start the HEVC bridge.')); });
    child.on('close', code => {
      closed = true;
      cleanup(); finish();
      if (!ready) reject(new Error(message || 'HEVC bridge stopped before connecting.'));
      else if (!stopping) onFailure(new Error(message || `HEVC transport stopped (exit ${code}).`));
    });
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
  });
}
