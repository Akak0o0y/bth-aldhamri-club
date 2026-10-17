import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, presetKbps, assessQuality, captureOptions } from '../src/stream/quality.js';
import { createNetworkGuard } from '../src/stream/networkGuard.js';

test('1440p60 quality preset and capture ask for native dimensions without illegal exact constraints', () => {
  const preset = PRESETS.find((p) => p.id === '1440');
  assert.equal(presetKbps(preset, 'h264', 60), 20000);
  const options = captureOptions(preset, 60);
  assert.deepEqual(options.video.width, { ideal: 2560, max: 2560 });
  assert.deepEqual(options.video.frameRate, { ideal: 60, max: 60 });
  assert.equal(JSON.stringify(options).includes('exact'), false);
});

test('quality status requires measured capture and outgoing dimensions and cadence', () => {
  const target = { width: 2560, height: 1440, fps: 60 };
  const good = { width: 2560, height: 1440, fps: 59.9, captureWidth: 2560, captureHeight: 1440, captureFps: 60, limitation: 'none' };
  assert.equal(assessQuality(null, target).state, 'checking');
  assert.equal(assessQuality(good, target).state, 'meeting');
  assert.equal(assessQuality({ ...good, captureFps: null }, target).state, 'checking');
  assert.equal(assessQuality({ ...good, captureFps: 30 }, target).state, 'capture');
  assert.equal(assessQuality({ ...good, width: 1920, height: 1080 }, target).state, 'resolution');
  assert.equal(assessQuality({ ...good, fps: 40 }, target).state, 'framerate');
  assert.equal(assessQuality({ ...good, limitation: 'cpu' }, target).state, 'cpu');
});

test('healthy TCP is not arbitrarily capped; sustained congestion backs off and recovers', () => {
  const guard = createNetworkGuard();
  const healthy = { protocol: 'tcp', sendDelayMs: 5, rttMs: 30, lossPct: 0, limitation: 'none', kbps: 18000 };
  for (let i = 0; i < 20; i++) assert.equal(guard(healthy, 20000, 20000), null);
  const slow = { ...healthy, sendDelayMs: 180 };
  assert.equal(guard(slow, 20000, 20000), null);
  assert.equal(guard(slow, 20000, 20000), null);
  assert.equal(guard(slow, 20000, 20000), 16000);
  for (let i = 0; i < 9; i++) assert.equal(guard(healthy, 16000, 20000), null);
  assert.equal(guard(healthy, 16000, 20000), 17600);
});

test('missing telemetry and CPU pressure do not cause bitrate oscillation', () => {
  const guard = createNetworkGuard();
  for (let i = 0; i < 30; i++) {
    assert.equal(guard({ protocol: 'tcp' }, 6000, 20000), null);
    assert.equal(guard({ protocol: 'udp', limitation: 'cpu', sendDelayMs: 0, rttMs: 10, lossPct: 0 }, 6000, 20000), null);
  }
});

test('recovery never exceeds the chosen ceiling and reduction respects a low ceiling', () => {
  const guard = createNetworkGuard();
  const good = { sendDelayMs: 0, rttMs: 20, lossPct: 0, limitation: 'none' };
  for (let i = 0; i < 9; i++) guard(good, 19500, 20000);
  assert.equal(guard(good, 19500, 20000), 20000);
  for (let i = 0; i < 3; i++) assert.equal(guard({ sendDelayMs: 200 }, 1000, 1000), null);
});
