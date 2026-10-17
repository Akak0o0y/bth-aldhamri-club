import test from 'node:test';
import assert from 'node:assert/strict';
import { pickAutoCodec, probeEncoders } from '../src/stream/codecs.js';

test('probe uses the requested 1440p60 bitrate and respects unsupported configurations', async () => {
  const beforeWindow = globalThis.window;
  const beforeNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const queries = [];
  globalThis.window = { RTCRtpSender: { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }, { mimeType: 'video/AV1' }] }) } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaCapabilities: {
    encodingInfo: async (query) => {
      queries.push(query);
      return { supported: query.video.contentType !== 'video/AV1', smooth: true, powerEfficient: true };
    },
  } } });
  try {
    const probes = await probeEncoders({ width: 2560, height: 1440, fps: 60, codecKbps: { h264: 20000, av1: 12000 } });
    assert.equal(queries[0].video.width, 2560);
    assert.equal(queries[0].video.framerate, 60);
    assert.equal(queries[0].video.bitrate, 20000000);
    assert.equal(queries[1].video.bitrate, 12000000);
    assert.equal(probes.find((p) => p.id === 'av1').supported, false);
    assert.equal(pickAutoCodec(probes), 'h264');
  } finally {
    if (beforeWindow === undefined) delete globalThis.window;
    else globalThis.window = beforeWindow;
    if (beforeNavigator) Object.defineProperty(globalThis, 'navigator', beforeNavigator);
    else delete globalThis.navigator;
  }
});

test('automatic selection avoids a hardware path predicted to drop frames', () => {
  assert.equal(pickAutoCodec([
    { id: 'h264', supported: true, hw: true, smooth: false },
    { id: 'vp9', supported: true, hw: true, smooth: true },
  ]), 'vp9');
});
