// Where the media server lives. The room name doubles as the MediaMTX path,
// so the invite link carries everything a friend needs to start watching.
import { readJSON, writeJSON } from '../lib/store';

const KEY = 'majlis.stream.v1';

// Railway project "majlis-dhamrah" (ams): media over ICE-TCP via its TCP proxy.
export const CLOUD_MEDIAMTX_URL = 'https://mediamtx-production-dc92.up.railway.app';

// Everything runs in the cloud — no local media server by default.
// VITE_MEDIAMTX_URL overrides it at build time; ?server= overrides per link.
function defaultServer() {
  return import.meta.env.VITE_MEDIAMTX_URL || CLOUD_MEDIAMTX_URL;
}

const LOCAL_SERVER = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/;
const RETIRED_SERVERS = ['https://mediamtx-production-cb12.up.railway.app'];

const cleanServer = (value) => value.trim().replace(/\/+$/, '');
const cleanRoom = (value) => value.trim().replace(/^\/+|\/+$/g, '') || 'majlis';

export function loadConfig() {
  const saved = readJSON(KEY, {});
  const params = new URLSearchParams(location.search);
  let server = params.get('server');
  if (!server) {
    // Saved values from local testing or the retired server move to the cloud.
    const old = saved.server;
    server = !old || LOCAL_SERVER.test(old) || RETIRED_SERVERS.includes(cleanServer(old)) ? defaultServer() : old;
  }
  const config = {
    server: cleanServer(server),
    room: cleanRoom(params.get('room') || saved.room || 'majlis'),
    // Only the broadcaster needs these: MediaMTX guards publishing with them.
    publishUser: saved.publishUser || '',
    publishPass: saved.publishPass || '',
  };
  if (params.has('server') || params.has('room')) saveConfig(config);
  return config;
}

export function saveConfig(config) {
  const clean = {
    server: cleanServer(config.server),
    room: cleanRoom(config.room),
    publishUser: (config.publishUser || '').trim(),
    publishPass: config.publishPass || '',
  };
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
