// WHIP publisher: one encode, sent once to the server (MediaMTX forwards it
// to every viewer without transcoding). That keeps the broadcaster's CPU and
// upload flat no matter how many friends join.
import { preferCodec } from './codecs.js';
import { applyVideoEncoding } from './encoding.js';
import { authHeaders, linkToIceServers, parseOffer, sdpFragment, tunePublisherAnswer, tunePublisherOffer } from './sdp.js';

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
  #audioSender = null;
  // What is sent now. Hold swaps these without a new session; a reconnect
  // picks up whatever is current.
  #tracks;
  // Whether the session negotiates audio. It stays fixed for the publisher's
  // life so a held (silent) stream can get its mic back in place.
  #hasAudio;
  #auth;
  #encodingQueue = Promise.resolve();

  // opts: { url, token? | user?+pass?, stream, codecId, videoKbps, fps, contentHint, music, audioKbps, onStatus }
  constructor(opts) {
    this.#opts = opts;
    this.#auth = authHeaders(opts);
    this.#tracks = { video: opts.stream.getVideoTracks()[0] ?? null, audio: opts.stream.getAudioTracks()[0] ?? null };
    this.#hasAudio = Boolean(this.#tracks.audio);
  }

  get pc() {
    return this.#pc;
  }

  get hasAudio() {
    return this.#hasAudio;
  }

  // null sends nothing on that slot (silence / no new frames) and keeps it.
  async replaceTracks({ video, audio }) {
    const jobs = [];
    if (video !== undefined) {
      this.#tracks.video = video;
      if (this.#videoSender) jobs.push(this.#videoSender.replaceTrack(video));
    }
    if (audio !== undefined) {
      this.#tracks.audio = audio;
      if (this.#audioSender) jobs.push(this.#audioSender.replaceTrack(audio));
    }
    await Promise.all(jobs);
  }

  start() {
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    this.#teardown();
  }

  // Serialize transactions: slider changes and congestion recovery may overlap.
  updateEncoding(change) {
    const token = this.#token;
    const update = async () => {
      const sender = this.#videoSender;
      if (!sender || token !== this.#token || this.#stopped) return false;
      const next = { ...this.#opts, ...change };
      await applyVideoEncoding(sender, next);
      if (sender !== this.#videoSender || token !== this.#token) return false;
      this.#opts = next;
      return true;
    };
    this.#encodingQueue = this.#encodingQueue.catch(() => {}).then(update);
    return this.#encodingQueue;
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
    this.#videoSender = this.#audioSender = null;
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

    const { video, audio } = this.#tracks;
    // 'detail' keeps text razor sharp, 'motion' keeps games fluid.
    if (video) video.contentHint = o.contentHint;
    const videoT = pc.addTransceiver(video ?? 'video', {
      direction: 'sendonly',
      streams: [o.stream],
      sendEncodings: [{ maxBitrate: o.videoKbps * 1000, maxFramerate: o.fps, priority: 'high', networkPriority: 'high' }],
    });
    preferCodec(videoT, o.codecId);
    this.#videoSender = videoT.sender;
    if (this.#hasAudio) {
      if (audio) audio.contentHint = o.music ? 'music' : 'speech';
      const t = pc.addTransceiver(audio ?? 'audio', {
        direction: 'sendonly',
        streams: [o.stream],
        sendEncodings: [{ maxBitrate: o.audioKbps * 1000, priority: 'high', networkPriority: 'high' }],
      });
      this.#audioSender = t.sender;
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
      await this.updateEncoding({}).catch((err) => {
        if (live()) this.#opts.onEncodingError?.(err);
      });
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
