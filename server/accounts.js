// Streamer accounts: anyone with an account may broadcast and invite more
// streamers. One small JSON file (on a Railway volume in production) holds
// every account and pending invite — a friends' majlis has dozens, not
// millions. Passwords are scrypt-hashed; sessions are HMAC-signed tokens, so
// checking one needs no lookup beyond "does this account still exist".
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const DIR = process.env.DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url));
const FILE = join(DIR, 'accounts.json');
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;
const INVITE_TTL = 7 * 24 * 60 * 60 * 1000;
// Letters/digits in any script plus _ . - and @ + so an email works as a name.
const NAME = /^[\p{L}\p{N}_.@+-]{3,64}$/u;
// Without AUTH_SECRET (local dev) sessions simply end when the process restarts.
const SECRET = process.env.AUTH_SECRET || randomBytes(32).toString('hex');

// Null-prototype maps: a name like "__proto__" is just another key.
const dict = (obj) => Object.assign(Object.create(null), obj);
const db = load();

function load() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    return { users: dict(raw.users), invites: dict(raw.invites) };
  } catch {
    return { users: dict(), invites: dict() };
  }
}

function save() {
  mkdirSync(DIR, { recursive: true });
  // Write-then-rename: a crash mid-write never leaves half a file.
  writeFileSync(`${FILE}.tmp`, JSON.stringify(db));
  renameSync(`${FILE}.tmp`, FILE);
}

const keyOf = (name) => name.normalize('NFKC').toLowerCase();
const hashOf = async (pass, salt) => (await scryptAsync(pass, salt, 32)).toString('base64');

export const validName = (name) => typeof name === 'string' && NAME.test(name);
export const validPass = (pass) => typeof pass === 'string' && pass.length >= 8 && pass.length <= 128;

async function createUser(name, pass, by = null) {
  const salt = randomBytes(16).toString('base64');
  const hash = await hashOf(pass, salt);
  const key = keyOf(name);
  if (db.users[key]) return null;
  db.users[key] = { name, salt, hash, created: Date.now(), by };
  save();
  return name;
}

export async function checkPassword(name, pass) {
  if (typeof name !== 'string' || typeof pass !== 'string') return null;
  const user = db.users[keyOf(name)];
  if (!user) return null;
  const got = Buffer.from(await hashOf(pass, user.salt), 'base64');
  return timingSafeEqual(got, Buffer.from(user.hash, 'base64')) ? user.name : null;
}

// --- sessions ----------------------------------------------------------------

const sign = (data) => createHmac('sha256', SECRET).update(data).digest('base64url');

export function issueToken(name) {
  const body = Buffer.from(JSON.stringify({ u: name, exp: Date.now() + TOKEN_TTL })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function readToken(token) {
  if (typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = sign(body);
  if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
    // A removed account loses its sessions too.
    const user = typeof u === 'string' ? db.users[keyOf(u)] : null;
    return exp > Date.now() && user ? user.name : null;
  } catch {
    return null;
  }
}

// --- invites -----------------------------------------------------------------

function pruneInvites() {
  const now = Date.now();
  for (const code in db.invites) if (db.invites[code].expires < now) delete db.invites[code];
}

export function createInvite(by) {
  pruneInvites();
  const code = randomBytes(9).toString('base64url');
  db.invites[code] = { by, expires: Date.now() + INVITE_TTL };
  save();
  return { code, expires: db.invites[code].expires };
}

export function getInvite(code) {
  const invite = typeof code === 'string' ? db.invites[code] : null;
  return invite && invite.expires > Date.now() ? invite : null;
}

// Single use: the invite is spent before the slow hash so two tabs can't both
// redeem it, and handed back if the name turns out to be taken.
export async function redeemInvite(code, name, pass) {
  const invite = getInvite(code);
  if (!invite) return { error: 'invite' };
  delete db.invites[code];
  const created = await createUser(name, pass, invite.by);
  if (!created) {
    db.invites[code] = invite;
    return { error: 'taken' };
  }
  return { name: created };
}

// First boot: the owner account comes from ADMIN_USER / ADMIN_PASS.
export async function seedAdmin(name, pass) {
  if (!validName(name) || !validPass(pass) || Object.keys(db.users).length) return;
  await createUser(name, pass);
  console.log(`created the first account: ${name}`);
}
