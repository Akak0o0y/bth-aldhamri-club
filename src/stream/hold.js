// Hold ("be right back"): viewers stay connected and see a card while the
// streamer is away or changes settings. These decisions are pure so they can
// be tested without a browser.

// A new capture is needed for a new source or camera, or when the old one is
// gone (the camera and mic are released while holding; a shared screen stays
// picked). Resolution and frame-rate changes are constraints on the same track.
export function needsCapture(current, next, captureAlive) {
  if (!captureAlive || next.source !== current.source) return true;
  return next.source === 'camera' && next.facing !== current.facing;
}

// Tracks swap on the open connection, so viewers never reconnect, unless the
// codec changes or audio appears where the session negotiated none: those
// need a new WHIP session. Losing audio just sends silence.
export function needsReconnect(current, next, { hadAudio, hasAudio }) {
  return next.codecId !== current.codecId || (hasAudio && !hadAudio);
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
