// WHIP publisher: one encode, sent once to the server (MediaMTX forwards it
// to every viewer without transcoding). That keeps the broadcaster's CPU and
// upload flat no matter how many friends join.
import { preferCodec } from './codecs';
import { authHeaders, linkToIceServers, parseOffer, sdpFragment, tunePublisherAnswer, tunePublisherOffer } from './sdp';

const FALLBACK_ICE = [{ urls: 'stun:stun.l.google.com:19302' }];

export class WhipPublisher {
  #opts;
  #pc = null;
  #session = null;
  #offer = null;
  #pending = [];
  #token = 0;
  #retryTimer = null;
  #stopped = true;
  #videoSender = null;
  #auth;

  // opts: { url, token? | user?+pass?, stream, codecId, videoKbps, fps, contentHint, music, audioKbps, onStatus }
  constructor(opts) {
    this.#opts = opts;
    this.#auth = authHeaders(opts);
  }

  get pc() {
    return this.#pc;
  }

  start() {
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    this.#teardown();
  }

  // Live re-tune without renegotiation (used by the CPU guard and the
  // bitrate slider while on air).
  async updateEncoding({ videoKbps, fps, scaleDown }) {
    if (videoKbps) this.#opts.videoKbps = videoKbps;
    if (fps) this.#opts.fps = fps;
    const sender = this.#videoSender;
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    const enc = params.encodings[0];
    enc.maxBitrate = this.#opts.videoKbps * 1000;
    enc.maxFramerate = this.#opts.fps;
    if (scaleDown) enc.scaleResolutionDownBy = scaleDown;
    // The streamer's chosen resolution is never shrunk: when the CPU or the
    // network can't keep up, the encoder gives up detail or frames instead.
    // Newer Chrome keeps the frame rate too; older browsers fall back.
    for (const pref of ['maintain-framerate-and-resolution', 'maintain-resolution']) {
      try {
        params.degradationPreference = pref;
        await sender.setParameters(params);
        return;
      } catch {
        // Unknown to this browser: try the next one.
      }
    }
    delete params.degradationPreference;
    await sender.setParameters(params).catch(() => {});
  }

  #status(status, message = '') {
    if (!this.#stopped) this.#opts.onStatus(status, message);
  }

  #teardown() {
    this.#token++;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    if (this.#pc) {
      this.#pc.onicecandidate = this.#pc.onconnectionstatechange = null;
      this.#pc.close();
      this.#pc = null;
    }
    if (this.#session) {
      fetch(this.#session, { method: 'DELETE', headers: this.#auth, keepalive: true }).catch(() => {});
      this.#session = null;
    }
    this.#videoSender = null;
    this.#pending = [];
  }

  #retry(status, message, delay) {
    this.#teardown();
    this.#status(status, message);
    if (this.#stopped) return;
    this.#retryTimer = setTimeout(() => this.#connect(), delay);
  }

  async #connect() {
    this.#teardown();
    const token = this.#token;
    const live = () => token === this.#token && !this.#stopped;
    const o = this.#opts;
    this.#status('connecting');

    let iceServers = FALLBACK_ICE;
    try {
      const res = await fetch(o.url, { method: 'OPTIONS', headers: this.#auth });
      iceServers = linkToIceServers(res.headers.get('Link')) ?? FALLBACK_ICE;
    } catch {
      if (live()) this.#retry('unreachable', 'تعذر الوصول إلى سيرفر البث — المعاينة محلية فقط', 5000);
      return;
    }
    if (!live()) return;

    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    this.#pc = pc;

    const [video] = o.stream.getVideoTracks();
    const [audio] = o.stream.getAudioTracks();
    if (video) {
      // 'detail' keeps text razor sharp, 'motion' keeps games fluid.
      video.contentHint = o.contentHint;
      const t = pc.addTransceiver(video, {
        direction: 'sendonly',
        streams: [o.stream],
        sendEncodings: [{ maxBitrate: o.videoKbps * 1000, maxFramerate: o.fps, priority: 'high', networkPriority: 'high' }],
      });
      preferCodec(t, o.codecId);
      this.#videoSender = t.sender;
    }
    if (audio) {
      audio.contentHint = o.music ? 'music' : 'speech';
      pc.addTransceiver(audio, {
        direction: 'sendonly',
        streams: [o.stream],
        sendEncodings: [{ maxBitrate: o.audioKbps * 1000, priority: 'high', networkPriority: 'high' }],
      });
    }

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      if (this.#session) this.#sendCandidates([e.candidate]);
      else this.#pending.push(e.candidate);
    };
    pc.onconnectionstatechange = () => {
      if (!live()) return;
      const state = pc.connectionState;
      if (state === 'connected') this.#status('live');
      else if (state === 'disconnected') this.#status('reconnecting');
      else if (state === 'failed' || state === 'closed') this.#retry('reconnecting', 'انقطع الاتصال بالسيرفر، جارٍ إعادة البث', 1500);
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.#offer = parseOffer(offer.sdp);

      const res = await fetch(o.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', ...this.#auth },
        body: tunePublisherOffer(offer.sdp, o),
      });
      if (!live()) return;
      if (res.status === 401 || res.status === 403) {
        // Missing or wrong publish password: retrying can't fix that.
        this.#teardown();
        this.#status('unauthorized', o.token || o.user ? 'الحساب غير مقبول أو انتهت الجلسة — سجّل الدخول من جديد' : 'البث لأصحاب الحسابات — سجّل الدخول أولاً');
        this.#stopped = true;
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let detail = text;
        try {
          detail = JSON.parse(text).error ?? text;
        } catch {
          // plain-text error body
        }
        throw new Error(`رفض السيرفر البث (${res.status}) ${detail}`.trim());
      }
      const location = res.headers.get('Location');
      if (location) this.#session = new URL(location, o.url).toString();
      const answer = await res.text();
      if (!live()) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: tunePublisherAnswer(answer, o) });
      if (this.#pending.length) this.#sendCandidates(this.#pending.splice(0));
      await this.updateEncoding({});
    } catch (err) {
      if (live()) this.#retry('error', err.message || String(err), 4000);
    }
  }

  #sendCandidates(candidates) {
    if (!this.#session || !this.#offer) return;
    fetch(this.#session, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/trickle-ice-sdpfrag', 'If-Match': '*', ...this.#auth },
      body: sdpFragment(this.#offer, candidates),
    }).catch(() => {});
  }
}
