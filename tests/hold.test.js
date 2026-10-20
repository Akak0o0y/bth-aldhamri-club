import test from 'node:test';
import assert from 'node:assert/strict';
import { gbPerViewerHour, perViewerMbps, viewerCapacity } from '../src/stream/capacity.js';
import { captureSupport } from '../src/stream/device.js';
import { formatElapsed, needsCapture, needsReconnect } from '../src/stream/hold.js';

test('one broadcast reaches as many viewers as the server upload allows', () => {
  // 2K60 H.264 default: 20 Mbps video + 128 kbps audio, plus transport overhead.
  assert.equal(perViewerMbps(20000, 128).toFixed(1), '22.1');
  assert.equal(viewerCapacity(1000, 20000, 128), 36);
  assert.equal(viewerCapacity(4000, 20000, 128), 144);
  // iPad camera, 1080p30 H.264.
  assert.equal(viewerCapacity(1000, 6500, 64), 110);
  assert.equal(viewerCapacity(480, 3300, 64), 103);
  assert.equal(viewerCapacity(0, 6500, 64), 0);
  assert.equal(viewerCapacity(1000, 0, 0), 0);
  assert.equal(gbPerViewerHour(20000, 128).toFixed(1), '10.0');
});

test('iPad Safari is told apart from a Mac and has no screen capture', () => {
  const ipad = captureSupport({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    maxTouchPoints: 5,
    mediaDevices: { getUserMedia() {} },
  });
  assert.deepEqual(ipad, { screen: false, camera: true, appleMobile: true });
  const mac = captureSupport({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    maxTouchPoints: 0,
    mediaDevices: { getUserMedia() {}, getDisplayMedia() {} },
  });
  assert.deepEqual(mac, { screen: true, camera: true, appleMobile: false });
  assert.deepEqual(captureSupport({}), { screen: false, camera: false, appleMobile: false });
});

test('resuming swaps tracks in place unless the codec or the track set changes', () => {
  const live = { source: 'screen', codecId: 'h264', facing: 'user' };
  assert.equal(needsCapture(live, { ...live }, true), false);
  assert.equal(needsCapture(live, { ...live }, false), true);
  assert.equal(needsCapture(live, { ...live, source: 'camera' }, true), true);
  const cam = { source: 'camera', codecId: 'h264', facing: 'user' };
  assert.equal(needsCapture(cam, { ...cam, facing: 'environment' }, true), true);
  // The facing only matters for a camera.
  assert.equal(needsCapture(live, { ...live, facing: 'environment' }, true), false);

  assert.equal(needsReconnect(live, { ...live }, { hadAudio: true, hasAudio: true }), false);
  assert.equal(needsReconnect(live, { ...live, codecId: 'av1' }, { hadAudio: true, hasAudio: true }), true);
  assert.equal(needsReconnect(live, { ...live }, { hadAudio: false, hasAudio: true }), true);
  assert.equal(needsReconnect(live, { ...live }, { hadAudio: true, hasAudio: false }), false);
});

test('hold and on-air times read as a clock', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(65_400), '1:05');
  assert.equal(formatElapsed(3_725_000), '1:02:05');
  assert.equal(formatElapsed(-5), '0:00');
});
