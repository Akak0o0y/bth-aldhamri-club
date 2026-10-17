import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

// No shell: filenames, device names and user input remain individual arguments.
export function run(command, args, { timeout = 15000, input, signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', pending = '', current = {}, settled = false;
    let timedOut = false, cancelled = false, killTimer;
    const started = performance.now();
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.write('q\n', () => {});
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    const abort = () => { cancelled = true; stop(); };
    const timer = timeout ? setTimeout(() => { timedOut = true; stop(); }, timeout) : null;
    child.stdin.on('error', () => {});
    if (input !== undefined) child.stdin.end(input);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout = (stdout + text).slice(-65536);
      if (!onProgress) return;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const at = line.indexOf('=');
        if (at < 0) continue;
        const key = line.slice(0, at), value = line.slice(at + 1).trim();
        if (key === 'progress') {
          if (Number.isFinite(current.frame)) onProgress({ ...current, elapsed: (performance.now() - started) / 1000 });
          current = {};
        } else if (['frame', 'fps', 'drop_frames', 'dup_frames', 'out_time_us'].includes(key)) current[key] = Number(value);
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16384); });
    const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.on('error', error => { if (!settled) { settled = true; cleanup(); reject(error); } });
    child.on('close', (code) => { if (!settled) { settled = true; cleanup(); resolve({ code, stdout, stderr, timedOut, cancelled }); } });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function failureDetail(result) {
  // Never include full SDP, ICE passwords, or arbitrary process output in a report.
  const lines = result.stderr.split(/\r?\n/);
  const reason = lines.find(line => /Driver does not support|minimum required|Cannot load|No capable|No device|Error initializing|Unknown encoder|Unknown filter|AMF.*failed|MFX.*unsupported|Failed to create|Could not create/i.test(line));
  return reason?.replace(/^\[[^\]]+\]\s*/, '').slice(0, 220) || (result.timedOut ? 'Probe timed out.' : `Encoder probe failed (exit ${result.code}).`);
}
