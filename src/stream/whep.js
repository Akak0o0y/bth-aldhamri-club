// WHEP viewer. Zero-buffer playout: jitterBufferTarget / playoutDelayHint = 0
// hands every decoded frame to the screen immediately (same trick as
// binbat/live777's player-core). Reconnects on its own and stays quiet while
// the tab is hidden, so an idle "waiting for host" screen costs nothing.
import { linkToIceServers, parseOffer, sdpFragment, tuneViewerOffer } from './sdp';

const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

export function applyLatencyHints(receiver, lowLatency) {
  try {
    if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = lowLatency ? 0 : null;
  } catch {
    // Older engines reject null; ignore.
  }
  try {
    if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = lowLatency ? 0 : null;
  } catch {
    // Legacy Chrome-only hint.
  }
}

export class WhepPlayer {
  #url;
  #onStatus;
  #onStream;
  #lowLatency;
  #pc = null;
  #session = null;
  #offer = null;
  #pending = [];
  #token = 0;
  #retryTimer = null;
  #graceTimer = null;
  #failures = 0;
  #stopped = true;

  constructor({ url, onStatus, onStream, lowLatency = true }) {
    this.#url = url;
    this.#onStatus = onStatus;
    this.#onStream = onStream;
    this.#lowLatency = lowLatency;
    this.onVisibility = this.onVisibility.bind(this);
  }

  get pc() {
    return this.#pc;
  }

  start() {
    this.#stopped = false;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.#teardown();
  }

  setLowLatency(on) {
    this.#lowLatency = on;
    this.#pc?.getReceivers().forEach((r) => applyLatencyHints(r, on));
  }

  onVisibility() {
    // A retry was postponed while hidden: run it now.
    if (!document.hidden && !this.#stopped && !this.#pc && !this.#retryTimer) this.#connect();
  }

  #status(status, message = '') {
    if (!this.#stopped) this.#onStatus(status, message);
  }

  #teardown() {
    this.#token++;
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#graceTimer);
    this.#retryTimer = this.#graceTimer = null;
    if (this.#pc) {
      this.#pc.ontrack = this.#pc.onicecandidate = this.#pc.onconnectionstatechange = null;
      this.#pc.close();
      this.#pc = null;
    }
    if (this.#session) {
      // keepalive lets the DELETE finish even during page unload.
      fetch(this.#session, { method: 'DELETE', keepalive: true }).catch(() => {});
      this.#session = null;
    }
    this.#pending = [];
    this.#offer = null;
  }

  #retry(status, message, delay) {
    this.#teardown();
    this.#status(status, message);
    if (this.#stopped) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (!document.hidden) this.#connect();
    }, delay);
  }

  async #connect() {
    this.#teardown();
    const token = this.#token;
    const live = () => token === this.#token && !this.#stopped;
    this.#status(this.#failures ? 'reconnecting' : 'connecting');

    let iceServers = FALLBACK_ICE;
    try {
      const res = await fetch(this.#url, { method: 'OPTIONS' });
      iceServers = linkToIceServers(res.headers.get('Link')) ?? FALLBACK_ICE;
    } catch {
      if (!live()) return;
      this.#failures++;
      return this.#retry('unreachable', 'تعذر الوصول إلى سيرفر البث', Math.min(15000, 4000 * this.#failures));
    }
    if (!live()) return;

    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    this.#pc = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    const stream = new MediaStream();
    pc.ontrack = (e) => {
      applyLatencyHints(e.receiver, this.#lowLatency);
      stream.addTrack(e.track);
      this.#onStream(stream);
    };
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      if (this.#session) this.#sendCandidates([e.candidate]);
      else this.#pending.push(e.candidate);
    };
    pc.onconnectionstatechange = () => {
      if (!live()) return;
      const state = pc.connectionState;
      if (state === 'connected') {
        clearTimeout(this.#graceTimer);
        this.#failures = 0;
        this.#status('live');
      } else if (state === 'disconnected') {
        // Short network blips recover by themselves; don't tear down yet.
        this.#status('reconnecting');
        this.#graceTimer = setTimeout(() => live() && this.#retry('reconnecting', '', 500), 2500);
      } else if (state === 'failed' || state === 'closed') {
        this.#failures++;
        this.#retry('reconnecting', 'انقطع الاتصال، جارٍ إعادة المحاولة', 1000);
      }
    };

    try {
      const offer = await pc.createOffer();
      offer.sdp = tuneViewerOffer(offer.sdp);
      await pc.setLocalDescription(offer);
      this.#offer = parseOffer(offer.sdp);

      const res = await fetch(this.#url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: offer.sdp,
      });
      if (!live()) return;
      if (res.status === 404) {
        // Nobody is publishing yet. Polling is cheap; back off gently.
        this.#failures = 0;
        return this.#retry('offline', 'لا يوجد بث حالياً', 3000);
      }
      if (!res.ok) throw new Error(`الخادم رد بالحالة ${res.status}`);

      const location = res.headers.get('Location');
      if (location) this.#session = new URL(location, this.#url).toString();
      const answer = await res.text();
      if (!live()) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      if (this.#pending.length) this.#sendCandidates(this.#pending.splice(0));
    } catch (err) {
      if (!live()) return;
      this.#failures++;
      this.#retry('error', err.message || String(err), Math.min(15000, 3000 * this.#failures));
    }
  }

  #sendCandidates(candidates) {
    if (!this.#session || !this.#offer) return;
    fetch(this.#session, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/trickle-ice-sdpfrag', 'If-Match': '*' },
      body: sdpFragment(this.#offer, candidates),
    }).catch(() => {
      // Servers without trickle support still connect via their own candidates.
    });
  }
}
