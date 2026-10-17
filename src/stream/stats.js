// Real telemetry from RTCPeerConnection.getStats(). Every number shown in the
// UI comes from here — rates are deltas between two samples.

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round = (v, digits = 0) => (v === null ? null : Number(v.toFixed(digits)));

function selectedPair(report) {
  let pair = null;
  report.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = report.get(s.selectedCandidatePairId);
  });
  if (pair) return pair;
  report.forEach((s) => {
    if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = s;
  });
  return pair;
}

function routeOf(report, pair) {
  if (!pair) return { path: null, protocol: null };
  const local = report.get(pair.localCandidateId);
  const remote = report.get(pair.remoteCandidateId);
  const relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
  return { path: relay ? 'relay' : local?.candidateType ?? null, protocol: local?.protocol ?? null };
}

const codecName = (report, id) => report.get(id)?.mimeType?.split('/')[1]?.toUpperCase() ?? null;

export function createSampler(pc, role, clock = () => performance.now()) {
  let prev = new Map();
  let prevTime = null;

  const delta = (id, key, cur) => {
    const before = prev.get(id)?.[key];
    return Number.isFinite(before) && Number.isFinite(cur) && cur >= before ? cur - before : null;
  };

  return async function sample() {
    const report = await pc.getStats();
    const now = clock();
    const seconds = prevTime !== null && now > prevTime ? (now - prevTime) / 1000 : null;
    const pair = selectedPair(report);
    const rttMs = num(pair?.currentRoundTripTime) !== null ? pair.currentRoundTripTime * 1000 : null;
    const out = { role, rttMs: round(rttMs), ...routeOf(report, pair), at: Date.now(), lossPct: null, captureFps: null, captureWidth: null, captureHeight: null };
    let totalBytes = 0;
    let haveBytes = false;
    const next = new Map();

    report.forEach((s) => {
      if (role === 'viewer' && s.type === 'inbound-rtp') {
        next.set(s.id, s);
        const dBytes = delta(s.id, 'bytesReceived', s.bytesReceived);
        if (dBytes !== null) {
          totalBytes += dBytes;
          haveBytes = true;
        }
        if (s.kind !== 'video') return;
        const dLost = delta(s.id, 'packetsLost', s.packetsLost);
        const dRecv = delta(s.id, 'packetsReceived', s.packetsReceived);
        const dBuf = delta(s.id, 'jitterBufferDelay', s.jitterBufferDelay);
        const dEmit = delta(s.id, 'jitterBufferEmittedCount', s.jitterBufferEmittedCount);
        const dDec = delta(s.id, 'totalDecodeTime', s.totalDecodeTime);
        const dFrames = delta(s.id, 'framesDecoded', s.framesDecoded);
        Object.assign(out, {
          width: num(s.frameWidth),
          height: num(s.frameHeight),
          fps: round(num(s.framesPerSecond) ?? (seconds && dFrames !== null ? dFrames / seconds : null), 1),
          codec: codecName(report, s.codecId),
          lossPct: dLost !== null && dRecv !== null && dLost + dRecv > 0 ? round((100 * dLost) / (dLost + dRecv), 2) : null,
          jitterMs: round(num(s.jitter) !== null ? s.jitter * 1000 : null),
          bufferMs: dBuf !== null && dEmit > 0 ? round((1000 * dBuf) / dEmit) : null,
          decodeMs: dDec !== null && dFrames > 0 ? round((1000 * dDec) / dFrames, 1) : null,
          framesDropped: num(s.framesDropped),
          freezes: num(s.freezeCount),
          // Only exposed by Chrome while the page is capturing; null otherwise.
          hw: typeof s.powerEfficientDecoder === 'boolean' ? s.powerEfficientDecoder : null,
          impl: s.decoderImplementation ?? null,
        });
      } else if (role === 'host' && s.type === 'outbound-rtp') {
        next.set(s.id, s);
        const dBytes = delta(s.id, 'bytesSent', s.bytesSent);
        if (dBytes !== null) {
          totalBytes += dBytes;
          haveBytes = true;
        }
        if (s.kind !== 'video') return;
        const dEnc = delta(s.id, 'totalEncodeTime', s.totalEncodeTime);
        const dFrames = delta(s.id, 'framesEncoded', s.framesEncoded);
        const dPackets = delta(s.id, 'packetsSent', s.packetsSent);
        const dSendDelay = delta(s.id, 'totalPacketSendDelay', s.totalPacketSendDelay);
        const source = report.get(s.mediaSourceId);
        if (source) next.set(source.id, source);
        const dCaptured = source ? delta(source.id, 'frames', source.frames) : null;
        Object.assign(out, {
          width: num(s.frameWidth),
          height: num(s.frameHeight),
          fps: round(num(s.framesPerSecond) ?? (seconds && dFrames !== null ? dFrames / seconds : null), 1),
          captureFps: round(num(source?.framesPerSecond) ?? (seconds && dCaptured !== null ? dCaptured / seconds : null), 1),
          captureWidth: num(source?.width),
          captureHeight: num(source?.height),
          codec: codecName(report, s.codecId),
          encodeMs: dEnc !== null && dFrames > 0 ? round((1000 * dEnc) / dFrames, 1) : null,
          sendDelayMs: dSendDelay !== null && dPackets > 0 ? round((1000 * dSendDelay) / dPackets, 1) : null,
          targetKbps: num(s.targetBitrate) !== null ? Math.round(s.targetBitrate / 1000) : null,
          limitation: s.qualityLimitationReason ?? null,
          hw: typeof s.powerEfficientEncoder === 'boolean' ? s.powerEfficientEncoder : null,
          impl: s.encoderImplementation ?? null,
        });
      } else if (role === 'host' && s.type === 'remote-inbound-rtp' && s.kind === 'video') {
        if (num(s.fractionLost) !== null) out.lossPct = round(s.fractionLost * 100, 2);
        if (out.rttMs === null && num(s.roundTripTime) !== null) out.rttMs = Math.round(s.roundTripTime * 1000);
      }
    });

    out.kbps = haveBytes && seconds ? Math.round((totalBytes * 8) / seconds / 1000) : null;

    // A rough estimate of THIS peer's leg only, not glass-to-glass latency.
    // End-to-end delay needs a stamped source and clock synchronization.
    const half = out.rttMs !== null ? out.rttMs / 2 : null;
    if (role === 'viewer') {
      out.latencyMs = half === null || out.bufferMs == null || out.decodeMs == null ? null : Math.round(half + out.bufferMs + out.decodeMs);
    } else {
      out.latencyMs = half === null || out.encodeMs == null || out.sendDelayMs == null ? null : Math.round(half + out.encodeMs + out.sendDelayMs);
    }

    prev = next;
    prevTime = now;
    return out;
  };
}
