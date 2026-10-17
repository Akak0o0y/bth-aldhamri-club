// WebRTC still owns congestion control. This ceiling guard reacts only to
// sustained queueing/loss, and cautiously restores the user's ceiling.
export function createNetworkGuard() {
  let bad = 0;
  let good = 0;
  return (stats, appliedKbps, requestedKbps) => {
    const queue = Number.isFinite(stats.sendDelayMs) ? stats.sendDelayMs : null;
    const loss = Number.isFinite(stats.lossPct) ? stats.lossPct : null;
    const rtt = Number.isFinite(stats.rttMs) ? stats.rttMs : null;
    const congested = (queue !== null && queue > 120) || (loss !== null && loss > 3) ||
      (rtt !== null && rtt > 400 && stats.limitation === 'bandwidth');
    const healthy = queue !== null && queue < 40 && rtt !== null && rtt < 200 &&
      loss !== null && loss < 1 && stats.limitation === 'none';
    bad = congested ? bad + 1 : 0;
    good = healthy ? good + 1 : 0;
    let next = appliedKbps;
    if (bad >= 3) {
      bad = good = 0;
      next = Math.max(Math.min(1000, requestedKbps), Math.floor(appliedKbps * 0.8 / 100) * 100);
    } else if (good >= 10 && appliedKbps < requestedKbps) {
      good = 0;
      next = Math.min(requestedKbps, Math.round(appliedKbps * 1.1 / 100) * 100);
    }
    return next === appliedKbps ? null : next;
  };
}
