import test from 'node:test';
import assert from 'node:assert/strict';
import { WhipPublisher } from '../src/stream/whip.js';

test('publisher serializes changes, recovers after rejection and discards updates after stop', async () => {
  const saved = { peer: globalThis.RTCPeerConnection, window: globalThis.window, fetch: globalThis.fetch };
  const applied = [];
  let active = 0;
  let overlap = false;
  let reject = false;
  let block;
  let entered;
  let transaction = 0;
  const sender = {
    getParameters: () => ({ transactionId: ++transaction, encodings: [{}] }),
    async setParameters(params) {
      active++;
      if (active > 1) overlap = true;
      entered?.();
      try {
        if (block) await block;
        await new Promise((r) => setTimeout(r, 1));
        if (reject) throw new Error('encoder busy');
        applied.push(params.encodings[0].maxBitrate);
      } finally { active--; }
    },
  };
  const sdp = 'v=0\r\na=ice-ufrag:test\r\na=ice-pwd:test\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:96 H264/90000\r\n';
  globalThis.window = {};
  globalThis.RTCPeerConnection = class {
    addTransceiver() { return { sender }; }
    async createOffer() { return { type: 'offer', sdp }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  };
  globalThis.fetch = async (_url, init) => ({ ok: true, status: 200, headers: new Headers(init.method === 'POST' ? { Location: '/session/test' } : {}), text: async () => sdp });
  const publisher = new WhipPublisher({
    url: 'http://localhost/test/whip', stream: { getVideoTracks: () => [{}], getAudioTracks: () => [] },
    videoKbps: 20000, fps: 60, contentHint: 'motion', codecId: 'h264', onStatus() {},
  });
  try {
    publisher.start();
    for (let i = 0; i < 100 && applied.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
    assert.deepEqual(applied, [20000000]);
    await Promise.all([publisher.updateEncoding({ videoKbps: 12000 }), publisher.updateEncoding({ videoKbps: 18000 })]);
    assert.deepEqual(applied, [20000000, 12000000, 18000000]);
    assert.equal(overlap, false);
    reject = true;
    await assert.rejects(publisher.updateEncoding({ videoKbps: 6000 }), /encoder busy/);
    reject = false;
    await publisher.updateEncoding({});
    assert.equal(applied.at(-1), 18000000); // Rejected settings were not remembered.
    let release;
    block = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const pending = publisher.updateEncoding({ videoKbps: 24000 });
    await started;
    publisher.stop();
    release();
    assert.equal(await pending, false);
    assert.equal(await publisher.updateEncoding({ videoKbps: 20000 }), false);
    block = entered = null;
    const beforeRestart = applied.length;
    publisher.start();
    for (let i = 0; i < 100 && applied.length === beforeRestart; i++) await new Promise((r) => setTimeout(r, 2));
    assert.equal(applied.length, beforeRestart + 1);
    assert.equal(applied.at(-1), 18000000); // A new connection retains only successful settings.
  } finally {
    publisher.stop();
    for (const [key, value] of [['RTCPeerConnection', saved.peer], ['window', saved.window], ['fetch', saved.fetch]]) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});

test('held tracks swap on the open connection and survive a reconnect', async () => {
  const saved = { peer: globalThis.RTCPeerConnection, window: globalThis.window, fetch: globalThis.fetch };
  const peers = [];
  const sdp = 'v=0\r\na=ice-ufrag:test\r\na=ice-pwd:test\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:96 H264/90000\r\n';
  globalThis.window = {};
  globalThis.RTCPeerConnection = class {
    constructor() { this.added = []; this.replaced = []; peers.push(this); }
    addTransceiver(trackOrKind) {
      this.added.push(trackOrKind);
      const sender = {
        getParameters: () => ({ encodings: [{}] }),
        async setParameters() {},
        replaceTrack: async (track) => { this.replaced.push(track); },
      };
      return { sender };
    }
    async createOffer() { return { type: 'offer', sdp }; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {}
  };
  globalThis.fetch = async (_url, init) => ({ ok: true, status: 200, headers: new Headers(init.method === 'POST' ? { Location: '/session/test' } : {}), text: async () => sdp });
  const camera = { kind: 'video', id: 'camera' };
  const mic = { kind: 'audio', id: 'mic' };
  const card = { kind: 'video', id: 'card' };
  const publisher = new WhipPublisher({
    url: 'http://localhost/test/whip', stream: { getVideoTracks: () => [camera], getAudioTracks: () => [mic] },
    videoKbps: 6000, fps: 30, contentHint: 'motion', codecId: 'h264', onStatus() {},
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 1)); };
  try {
    publisher.start();
    await settle();
    assert.deepEqual(peers[0].added, [camera, mic]);
    assert.equal(publisher.hasAudio, true);
    await publisher.replaceTracks({ video: card, audio: null });
    assert.deepEqual(peers[0].replaced, [card, null]);
    // A network retry while holding keeps sending the card, with the audio
    // slot still negotiated so the mic can come back without a new session.
    publisher.stop();
    publisher.start();
    await settle();
    assert.deepEqual(peers[1].added, [card, 'audio']);
    assert.equal(publisher.hasAudio, true);
  } finally {
    publisher.stop();
    for (const [key, value] of [['RTCPeerConnection', saved.peer], ['window', saved.window], ['fetch', saved.fetch]]) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
});
