// Where the media server lives. The room name doubles as the MediaMTX path,
// so the invite link carries everything a friend needs to start watching.
import { readJSON, writeJSON } from '../lib/store';

const KEY = 'majlis.stream.v1';

export const CLOUD_MEDIAMTX_URL = 'https://mediamtx-production-cb12.up.railway.app';

function defaultServer() {
  if (import.meta.env.VITE_MEDIAMTX_URL) return import.meta.env.VITE_MEDIAMTX_URL;
  if (location.hostname && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    return CLOUD_MEDIAMTX_URL;
  }
  const host = location.hostname || 'localhost';
  const scheme = location.protocol === 'https:' ? 'https' : 'http';
  return `${scheme}://${host}:8889`;
}

const cleanServer = (value) => value.trim().replace(/\/+$/, '');
const cleanRoom = (value) => value.trim().replace(/^\/+|\/+$/g, '') || 'majlis';

export function loadConfig() {
  const saved = readJSON(KEY, {});
  const params = new URLSearchParams(location.search);
  let server = params.get('server') || saved.server;
  if (location.protocol === 'https:' && (!server || server.startsWith('http://localhost') || server.startsWith('http://127.0.0.1'))) {
    server = defaultServer();
  } else if (!server) {
    server = defaultServer();
  }
  const config = {
    server: cleanServer(server),
    room: cleanRoom(params.get('room') || saved.room || 'majlis'),
  };
  if (params.has('server') || params.has('room')) saveConfig(config);
  return config;
}

export function saveConfig(config) {
  const clean = { server: cleanServer(config.server), room: cleanRoom(config.room) };
  writeJSON(KEY, clean);
  return clean;
}

export const whepUrl = ({ server, room }) => `${server}/${room}/whep`;
export const whipUrl = ({ server, room }) => `${server}/${room}/whip`;

export function inviteLink({ server, room }) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('server', server);
  url.searchParams.set('room', room);
  return url.toString();
}

// An https page cannot call an http media server (mixed content).
export function configProblem({ server }) {
  try {
    const url = new URL(server);
    if (location.protocol === 'https:' && url.protocol === 'http:') {
      return 'الموقع يعمل على https والسيرفر على http — المتصفح سيمنع الاتصال. استخدم https للسيرفر أيضاً.';
    }
    return null;
  } catch {
    return 'عنوان السيرفر غير صالح — مثال: http://192.168.1.10:8889';
  }
}
