import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { run } from './process.mjs';
import { secureUrl } from './core.mjs';

export function sessionPath() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('This companion currently supports Windows 10/11.');
  return join(process.env.LOCALAPPDATA, 'Dhamri', 'session.json');
}

export async function protect(value, operation) {
  const script = fileURLToPath(new URL('./credential.ps1', import.meta.url));
  // Process scope only: downloaded ZIPs carry Mark-of-the-Web and Windows
  // defaults can block this bundled helper. No persistent policy is changed.
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, operation], { input: value });
  if (result.code !== 0 || !result.stdout) throw new Error('Windows could not protect or unlock this login. Run dhamri login again.');
  return result.stdout.trim();
}

export function prompt(label, secret = false) {
  if (!process.stdin.isTTY) throw new Error('Run login in an interactive CMD window. Passwords are never accepted as command-line arguments.');
  if (!secret) return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(label, answer => { rl.close(); resolve(answer.trim()); });
  });
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    emitKeypressEvents(process.stdin);
    const previousRaw = Boolean(process.stdin.isRaw);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = '';
    const finish = () => {
      process.stdin.removeListener('keypress', handler);
      process.stdin.setRawMode(previousRaw);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const handler = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') { finish(); reject(new Error('Login cancelled.')); }
      else if (key.name === 'return') { finish(); resolve(value); }
      else if (key.name === 'backspace') value = [...value].slice(0, -1).join('');
      else if (!key.ctrl && !key.meta && text && [...text].every(char => char.codePointAt(0) >= 32 && char.codePointAt(0) !== 127)) value += text;
    };
    process.stdin.on('keypress', handler);
  });
}

export async function loginRequest(relay, name, pass) {
  const response = await fetch(`${secureUrl(relay)}/api/login`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, pass }),
  });
  if (!response.ok) throw new Error(response.status === 429 ? 'Too many login attempts. Wait before trying again.' : `Login failed (HTTP ${response.status}). Check your broadcaster account.`);
  const data = await response.json();
  if (typeof data.token !== 'string' || !/^[^/\s?#]+$/.test(data.room || '') || typeof data.name !== 'string') throw new Error('Unexpected login response.');
  return { token: data.token, room: data.room, name: data.name };
}

export async function saveSession(session, config) {
  const path = sessionPath();
  const encrypted = await protect(session.token, 'protect');
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ name: session.name, room: session.room, server: config.server, relay: config.relay, encrypted }), { flag: 'wx' });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function loadSession(options) {
  let stored;
  try { stored = JSON.parse(await readFile(sessionPath(), 'utf8')); }
  catch { throw new Error('No saved login. Run dhamri login first.'); }
  const server = secureUrl(options.server || stored.server);
  const relay = secureUrl(options.relay || stored.relay);
  if (server !== stored.server || relay !== stored.relay) throw new Error('This login belongs to a different server. Run dhamri login with the new --server and --relay.');
  const token = await protect(stored.encrypted, 'unprotect');
  const response = await fetch(`${relay}/api/me`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Login is unavailable or expired (HTTP ${response.status}). Run dhamri login.`);
  const account = await response.json();
  if (typeof account.room !== 'string' || !/^[^/\s?#]+$/.test(account.room)) throw new Error('Account has no valid broadcast channel.');
  return { token, room: account.room, name: account.name, server, relay };
}
