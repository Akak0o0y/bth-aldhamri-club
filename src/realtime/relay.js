// Where the realtime relay (server/realtime.js) lives. It carries the chat
// socket and the streamer-accounts API, so both read their address here.
import { trustedRelay } from './trustedRelay';

export const CLOUD_REALTIME_URL = 'wss://realtime-production-988e.up.railway.app';

// ?rt= overrides for testing, the build bakes in the deployed relay, a site on
// any other host uses the cloud relay, and a local dev server uses this machine.
export function relayUrl() {
  const param = new URLSearchParams(location.search).get('rt');
  if (param) return param;
  if (import.meta.env.VITE_REALTIME_URL) return import.meta.env.VITE_REALTIME_URL;
  if (location.hostname && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    return CLOUD_REALTIME_URL;
  }
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname || 'localhost'}:8787`;
}

// Same server over HTTP(S), for the accounts API.
export const relayHttpUrl = () => trustedRelay(relayUrl(), {
  pageUrl: location.href,
  trustedRelay: import.meta.env.VITE_REALTIME_URL || CLOUD_REALTIME_URL,
}).replace(/^ws/, 'http');
