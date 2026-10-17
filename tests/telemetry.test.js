import test from 'node:test';
import assert from 'node:assert/strict';
import { createSampler } from '../src/stream/stats.js';
import { applyLatencyHints } from '../src/stream/latency.js';
import { applyVideoEncoding } from '../src/stream/encoding.js';
import { tunePublisherAnswer } from '../src/stream/sdp.js';

test('source FPS, outgoing FPS and packet wait are independent measured rates', async () => {
  let tick = 0;
  const pc = { getStats: async () => new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { currentRoundTripTime: 0.04, localCandidateId: 'local' }],
    ['local', { candidateType: 'host', protocol: 'tcp' }],
    ['source', { id: 'source', type: 'media-source', kind: 'video', width: 2560, height: 1440, frames: 100 + 30 * tick }],
    ['video', { id: 'video', type: 'outbound-rtp', kind: 'video', mediaSourceId: 'source', frameWidth: 2560, frameHeight: 1440, framesEncoded: 100 + 60 * tick, packetsSent: 100 + 100 * tick, bytesSent: 1000 + 10000 * tick, totalEncodeTime: 1 + 0.3 * tick, totalPacketSendDelay: 1 + 2 * tick, qualityLimitationReason: 'none' }],
  ]) };
  const sample = createSampler(pc, 'host', () => tick * 1000);
  const first = await sample();
  assert.equal(first.lossPct, null);
  assert.equal(first.sendDelayMs, null);
  tick++;
  const next = await sample();
  assert.equal(next.captureFps, 30);
  assert.equal(next.fps, 60);
  assert.equal(next.encodeMs, 5);
  assert.equal(next.sendDelayMs, 20);
  assert.equal(next.kbps, 80);
  assert.equal(next.latencyMs, 45); // Only this leg: 20 RTT/2 + 5 encode + 20 queue.
});

test('counter resets and absent packet-loss data stay unknown', async () => {
  let time = 0;
  let frames = 100;
  const sample = createSampler({ getStats: async () => new Map([
    ['v', { id: 'v', type: 'inbound-rtp', kind: 'video', framesDecoded: frames, bytesReceived: frames * 100, totalDecodeTime: frames / 100 }],
  ]) }, 'viewer', () => time);
  await sample();
  time = 1000;
  frames = 10;
  const stats = await sample();
  assert.equal(stats.fps, null);
  assert.equal(stats.kbps, null);
  assert.equal(stats.lossPct, null);
  assert.equal(stats.latencyMs, null);
});

test('receiver hints use correct units and can restore browser defaults', () => {
  const receiver = { jitterBufferTarget: null, playoutDelayHint: null };
  applyLatencyHints(receiver, true);
  assert.equal(receiver.jitterBufferTarget, 100);
  assert.equal(receiver.playoutDelayHint, 0.1);
  applyLatencyHints(receiver, false);
  assert.equal(receiver.jitterBufferTarget, null);
  assert.equal(receiver.playoutDelayHint, null);
  assert.doesNotThrow(() => applyLatencyHints({}, true));
});

test('encoder retry uses a fresh transaction and reports failure when settings cannot apply', async () => {
  let reads = 0;
  const writes = [];
  const sender = {
    getParameters: () => ({ transactionId: ++reads, encodings: [{}] }),
    setParameters: async (params) => { writes.push(params); if (params.degradationPreference) throw new Error('Unsupported preference'); },
  };
  await applyVideoEncoding(sender, { videoKbps: 20000, fps: 60, contentHint: 'motion' });
  assert.deepEqual(writes.map((p) => p.transactionId), [1, 2]);
  assert.equal(writes[1].encodings[0].maxBitrate, 20000000);
  assert.equal(writes[1].encodings[0].scaleResolutionDownBy, 1);
  sender.setParameters = async () => { throw new Error('Rejected'); };
  await assert.rejects(applyVideoEncoding(sender, { videoKbps: 20000, fps: 60 }), /Rejected/);
});

test('SDP leaves room for the live slider without forcing a congestion floor', () => {
  const sdp = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;profile-level-id=42e01f\r\n';
  const result = tunePublisherAnswer(sdp, { videoKbps: 20000, audioKbps: 128 });
  assert.match(result, /b=TIAS:30000000/);
  assert.match(result, /x-google-min-bitrate=0/);
  assert.match(result, /x-google-start-bitrate=6000/);
  assert.match(result, /profile-level-id=42e01f/);
});
