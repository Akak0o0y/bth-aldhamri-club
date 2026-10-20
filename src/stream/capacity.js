// How many viewers one broadcast can reach. MediaMTX forwards the single
// encode to every viewer, so the streamer's upload stays flat however many
// join; the server's upload is what runs out, because every viewer receives
// the whole stream again.

// RTP/SRTP/UDP headers and retransmissions on top of the media bitrate.
export const TRANSPORT_OVERHEAD = 1.1;
// Keep a fifth of the link free for keyframe bursts and everything else.
export const USABLE_SHARE = 0.8;
// The reference the studio quotes: a 1 Gbps server port.
export const REFERENCE_SERVER_MBPS = 1000;

export function perViewerMbps(videoKbps, audioKbps = 0) {
  return ((videoKbps + audioKbps) * TRANSPORT_OVERHEAD) / 1000;
}

export function viewerCapacity(serverMbps, videoKbps, audioKbps = 0) {
  const each = perViewerMbps(videoKbps, audioKbps);
  if (!(each > 0) || !(serverMbps > 0)) return 0;
  return Math.floor((serverMbps * USABLE_SHARE) / each);
}

// Data one viewer pulls from the server per hour, for monthly egress allowances.
export function gbPerViewerHour(videoKbps, audioKbps = 0) {
  return (perViewerMbps(videoKbps, audioKbps) * 3600) / 8 / 1000;
}
