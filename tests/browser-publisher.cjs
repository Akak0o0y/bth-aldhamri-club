// Real browser WHIP/controller integration with a local in-page receiver.
// Uses synthetic frames only; HTTP/WebSocket services and STUN stay offline.
const { chromium } = require(process.env.MAJLIS_PLAYWRIGHT || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.MAJLIS_CHROME ? { executablePath: process.env.MAJLIS_CHROME } : {}) });
  const context = await browser.newContext();
  const origin = process.env.MAJLIS_LOCAL_URL || 'http://127.0.0.1:5177';
  try {
    await context.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/?server=http://127.0.0.1:9&rt=ws://127.0.0.1:9`);
    const result = await page.evaluate(async () => {
      const { goLive, setLiveBitrate, stopLive, stopViewing, streamStore, PRESETS } = await import('/src/stream/controller.js');
      stopViewing();
      const until = async (condition) => {
        const deadline = performance.now() + 15000;
        while (!condition()) {
          if (performance.now() > deadline) throw new Error(`Timed out: ${streamStore.get().status} ${streamStore.get().message}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };
      const NativePeer = window.RTCPeerConnection;
      const nativeFetch = window.fetch;
      let publishingPeer;
      // Keep the publisher's real sender/SDP behavior, without public STUN.
      window.RTCPeerConnection = class extends NativePeer {
        constructor(options) { super({ ...options, iceServers: [] }); publishingPeer = this; }
      };
      const receiver = new NativePeer({ iceServers: [] });
      const video = document.createElement('video');
      video.muted = true;
      video.autoplay = true;
      document.body.append(video);
      receiver.ontrack = ({ track }) => { video.srcObject = new MediaStream([track]); video.play().catch(() => {}); };
      window.fetch = async (url, options = {}) => {
        if (String(url).startsWith('http://127.0.0.1:9/')) {
          if (options.method === 'OPTIONS') return new Response(null, { status: 204 });
          if (options.method === 'POST' && String(url).includes('/whip')) {
            await receiver.setRemoteDescription({ type: 'offer', sdp: options.body });
            await receiver.setLocalDescription(await receiver.createAnswer());
            await until(() => receiver.iceGatheringState === 'complete');
            return new Response(receiver.localDescription.sdp, { status: 201, headers: { Location: '/session/quality' } });
          }
          if (options.method === 'PATCH') {
            let sdpMid = '0';
            for (const line of options.body.split('\r\n')) {
              if (line.startsWith('a=mid:')) sdpMid = line.slice(6);
              if (line.startsWith('a=candidate:')) await receiver.addIceCandidate({ sdpMid, candidate: line.slice(2) });
            }
            return new Response(null, { status: 204 });
          }
          if (options.method === 'DELETE') return new Response(null, { status: 204 });
          return new Response(null, { status: 404 });
        }
        return nativeFetch(url, options);
      };
      let track;
      try {
        const started = await goLive({ source: 'test', preset: PRESETS.find((p) => p.id === '1440'), fps: 60, codecId: 'h264', contentHint: 'motion', kbps: 20000 });
        if (!started.ok) throw new Error(started.error);
        track = streamStore.get().stream.getVideoTracks()[0];
        await until(() => streamStore.get().status === 'live' && streamStore.get().stats?.fps > 0 && video.videoWidth > 0);
        const measured = streamStore.get().stats;
        const outgoingPeer = publishingPeer;
        const sender = outgoingPeer.getSenders().find((s) => s.track?.kind === 'video');
        const concurrent = await Promise.all([setLiveBitrate(12000), setLiveBitrate(18000)]);
        const applied = { ...streamStore.get().publish, maxBitrate: sender.getParameters().encodings[0].maxBitrate };

        const write = sender.setParameters.bind(sender);
        sender.setParameters = async (parameters) => {
          if (parameters.encodings[0].maxBitrate === 22000000) throw new Error('Latest change rejected');
          return write(parameters);
        };
        const failedLatest = await Promise.all([setLiveBitrate(12000), setLiveBitrate(22000)]);
        const afterFailedLatest = { ...streamStore.get().publish, maxBitrate: sender.getParameters().encodings[0].maxBitrate };
        sender.setParameters = async () => { throw new Error('Simulated browser rejection'); };
        const rejected = await setLiveBitrate(6000);
        const afterRejection = { ...streamStore.get().publish };
        sender.setParameters = write;
        const recovered = await setLiveBitrate(24000);
        const afterRecovery = { ...streamStore.get().publish, maxBitrate: sender.getParameters().encodings[0].maxBitrate };

        let release;
        let entered;
        const gate = new Promise((resolve) => { release = resolve; });
        const entry = new Promise((resolve) => { entered = resolve; });
        sender.setParameters = async (parameters) => { entered(); await gate; return write(parameters); };
        const pending = setLiveBitrate(22000);
        await entry;
        stopLive();
        release();
        const stale = await pending;
        return {
          measured: { width: measured.width, height: measured.height, fps: measured.fps, codec: measured.codec, protocol: measured.protocol },
          received: { width: video.videoWidth, height: video.videoHeight },
          concurrent, applied, failedLatest, afterFailedLatest, rejected, afterRejection, recovered, afterRecovery, stale,
          final: { publish: streamStore.get().publish, role: streamStore.get().role, track: track.readyState, peer: outgoingPeer.connectionState },
        };
      } finally {
        stopLive();
        stopViewing();
        track?.stop();
        receiver.close();
        video.pause();
        video.srcObject = null;
        video.remove();
        window.RTCPeerConnection = NativePeer;
        window.fetch = nativeFetch;
      }
    });
    assert.equal(result.measured.codec, 'H264');
    assert.equal(result.measured.protocol, 'udp');
    assert(result.measured.fps > 0);
    assert.deepEqual(result.received, { width: 2560, height: 1440 });
    assert.deepEqual(result.concurrent, [false, true]);
    assert.equal(result.applied.kbps, 18000);
    assert.equal(result.applied.requestedKbps, 18000);
    assert.equal(result.applied.maxBitrate, 18000000);
    assert.deepEqual(result.failedLatest, [false, false]);
    assert.equal(result.afterFailedLatest.kbps, 12000);
    assert.equal(result.afterFailedLatest.requestedKbps, 12000);
    assert.equal(result.afterFailedLatest.maxBitrate, 12000000);
    assert.equal(result.rejected, false);
    assert.equal(result.afterRejection.kbps, 12000);
    assert.equal(result.afterRejection.requestedKbps, 12000);
    assert(result.afterRejection.encodingError);
    assert.equal(result.recovered, true);
    assert.equal(result.afterRecovery.kbps, 24000);
    assert.equal(result.afterRecovery.maxBitrate, 24000000);
    assert.equal(result.afterRecovery.encodingError, '');
    assert.equal(result.stale, false);
    assert.deepEqual(result.final, { publish: null, role: 'viewer', track: 'ended', peer: 'closed' });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ measured: result.measured, received: result.received, bitrateUpdates: 'serialized, rejection retained previous setting, recovery applied', cleanup: result.final, errors }, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
