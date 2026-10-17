export const LIVE_BUFFER_MS = 100;

export function applyLatencyHints(receiver, lowLatency) {
  // Standard API is milliseconds; the older Chromium hint is seconds.
  try {
    if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = lowLatency ? LIVE_BUFFER_MS : null;
  } catch { /* Unsupported setter: let the browser choose. */ }
  try {
    if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = lowLatency ? LIVE_BUFFER_MS / 1000 : null;
  } catch { /* Legacy API may be unavailable. */ }
}
