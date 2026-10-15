// Streamer login. The relay issues a signed session token; it stays on this
// device and goes out as the Bearer token when going live (MediaMTX asks the
// relay whether that token may publish). Watching never needs an account.
import { createStore, readJSON, writeJSON } from '../lib/store';
import { relayHttpUrl } from '../realtime/relay';
import { prefsStore, setPref } from '../ui/prefs';

const KEY = 'majlis.auth.v1';
const GUEST_NAME = 'ضيف المجلس';

const ERRORS = {
  login: 'اسم المستخدم أو كلمة المرور غير صحيحة',
  busy: 'محاولات كثيرة — انتظر عشر دقائق ثم حاول مجدداً',
  name: 'الاسم من 3 إلى 64 حرفاً أو رقماً، ويُسمح بـ _ . - @ + — يصلح البريد الإلكتروني اسماً',
  pass: 'كلمة المرور 8 أحرف على الأقل',
  taken: 'هذا الاسم مستخدم — اختر اسماً آخر',
  invite: 'رابط الدعوة غير صالح أو انتهت صلاحيته أو استُخدم من قبل',
  session: 'انتهت الجلسة — سجّل الدخول من جديد',
  current: 'كلمة المرور الحالية غير صحيحة',
  owner: 'هذا الإجراء لصاحب المجلس فقط',
  user: 'الحساب غير موجود — ربما حُذف من قبل',
};

export const authStore = createStore(readJSON(KEY, { name: '', token: '', owner: false, room: '' }));

async function call(path, { body, auth, method } = {}) {
  let res;
  try {
    res = await fetch(`${relayHttpUrl()}${path}`, {
      method: method || (body ? 'POST' : 'GET'),
      headers: auth ? { Authorization: `Bearer ${authStore.get().token}` } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('تعذر الوصول إلى السيرفر — تحقق من الاتصال');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === 'session') signOut();
    throw new Error(ERRORS[data.error] || `رد السيرفر بالحالة ${res.status}`);
  }
  return data;
}

function remember(auth) {
  writeJSON(KEY, auth);
  authStore.set(auth);
}

// `owner` only decides what the panel shows; the relay checks it on every call.
// `room` is the streamer's own channel: where they broadcast and what they share.
function signIn({ name, token, owner, room }) {
  remember({ name, token, owner: Boolean(owner), room: room || '' });
  // Chat under the account name unless the viewer already picked one.
  if (prefsStore.get().username === GUEST_NAME) setPref({ username: name });
}

export function signOut() {
  remember({ name: '', token: '', owner: false, room: '' });
}

export async function login(name, pass) {
  signIn(await call('/api/login', { body: { name: name.trim(), pass } }));
}

export async function register(code, name, pass) {
  signIn(await call('/api/register', { body: { code, name: name.trim(), pass } }));
  // The invite is spent; drop it from the address bar.
  const url = new URL(location.href);
  url.searchParams.delete('invite');
  history.replaceState(null, '', url);
}

export const lookupInvite = (code) => call(`/api/invites/${encodeURIComponent(code)}`);

export async function createInvite() {
  const { code, expires } = await call('/api/invites', { body: {}, auth: true });
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('invite', code);
  return { link: url.toString(), expires };
}

// A link like ?invite=CODE opens the sign-up form.
export const inviteCode = () => new URLSearchParams(location.search).get('invite');

// The relay signs out every other device; this one keeps going on a new token.
export async function changePassword(current, pass) {
  const { token } = await call('/api/password', { body: { current, pass }, auth: true });
  remember({ ...authStore.get(), token });
}

// Owner only: every account, and every invite not used yet.
export async function loadMembers() {
  const [{ users }, { invites }] = await Promise.all([call('/api/users', { auth: true }), call('/api/invites', { auth: true })]);
  return { users, invites };
}

export const removeUser = (name) => call(`/api/users/${encodeURIComponent(name)}`, { method: 'DELETE', auth: true });
export const revokeInvite = (code) => call(`/api/invites/${encodeURIComponent(code)}`, { method: 'DELETE', auth: true });

// Drops a session the relay no longer accepts (expired, password changed or
// account removed) and refreshes the owner flag and channel; a network failure
// keeps it.
export function checkSession() {
  const { token } = authStore.get();
  if (!token) return;
  call('/api/me', { auth: true }).then(({ owner, room }) => {
    if (authStore.get().token === token) remember({ ...authStore.get(), owner: Boolean(owner), room: room || '' });
  }, () => {});
}
