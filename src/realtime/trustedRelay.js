// A shared link can override chat routing, but must not redirect account
// passwords or signed session tokens to another server.
export function trustedRelay(relay, { pageUrl, trustedRelay: expectedRelay }) {
  const url = new URL(relay), page = new URL(pageUrl), trusted = new URL(expectedRelay);
  const local = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
  const development = local(page.hostname) && local(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (!development && (url.protocol !== 'wss:' || url.origin !== trusted.origin)) ||
      (page.protocol === 'https:' && url.protocol === 'ws:') || !['ws:', 'wss:'].includes(url.protocol)) throw new Error('untrusted-relay');
  return url.origin;
}
