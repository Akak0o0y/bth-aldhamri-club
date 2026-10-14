// SDP helpers shared by the WHIP publisher and the WHEP player.
// Trickle-ICE and Link-header parsing follow MediaMTX's own reader.js /
// publisher.js (github.com/bluenviron/mediamtx, internal/servers/webrtc).

export function linkToIceServers(link) {
  if (!link) return null;
  return link
    .split(', ')
    .map((entry) => {
      const m = entry.match(
        /^<(.+?)>; rel="ice-server"(; username="(.*?)"; credential="(.*?)"; credential-type="password")?/i,
      );
      if (!m) return null;
      const server = { urls: [m[1]] };
      if (m[3] !== undefined) {
        server.username = JSON.parse(`"${m[3]}"`);
        server.credential = JSON.parse(`"${m[4]}"`);
      }
      return server;
    })
    .filter(Boolean);
}

export function parseOffer(sdp) {
  const out = { iceUfrag: '', icePwd: '', medias: [] };
  for (const line of sdp.split('\r\n')) {
    if (line.startsWith('m=')) out.medias.push(line.slice(2));
    else if (!out.iceUfrag && line.startsWith('a=ice-ufrag:')) out.iceUfrag = line.slice(12);
    else if (!out.icePwd && line.startsWith('a=ice-pwd:')) out.icePwd = line.slice(10);
  }
  return out;
}

export function sdpFragment(offer, candidates) {
  const byMedia = new Map();
  for (const c of candidates) {
    if (!byMedia.has(c.sdpMLineIndex)) byMedia.set(c.sdpMLineIndex, []);
    byMedia.get(c.sdpMLineIndex).push(c);
  }
  let frag = `a=ice-ufrag:${offer.iceUfrag}\r\na=ice-pwd:${offer.icePwd}\r\n`;
  offer.medias.forEach((media, mid) => {
    const list = byMedia.get(mid);
    if (!list) return;
    frag += `m=${media}\r\na=mid:${mid}\r\n`;
    for (const c of list) frag += `a=${c.candidate}\r\n`;
  });
  return frag;
}

// --- section editing -------------------------------------------------------

function editMedia(sdp, kind, edit) {
  const parts = sdp.split('\r\nm=');
  for (let i = 1; i < parts.length; i++) {
    if (parts[i].startsWith(`${kind} `)) {
      const lines = parts[i].split('\r\n');
      edit(lines);
      parts[i] = lines.join('\r\n');
    }
  }
  return parts.join('\r\nm=');
}

function payloadTypes(lines, codecPattern) {
  const out = [];
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+) ([^/]+)\//);
    if (m && codecPattern.test(m[2])) out.push(m[1]);
  }
  return out;
}

function mergeFmtp(lines, pt, params) {
  const prefix = `a=fmtp:${pt} `;
  const idx = lines.findIndex((l) => l.startsWith(prefix));
  const map = new Map();
  if (idx >= 0) {
    for (const kv of lines[idx].slice(prefix.length).split(';')) {
      if (!kv.trim()) continue;
      const eq = kv.indexOf('=');
      map.set(eq < 0 ? kv.trim() : kv.slice(0, eq).trim(), eq < 0 ? '' : kv.slice(eq + 1).trim());
    }
  }
  for (const [k, v] of Object.entries(params)) map.set(k, String(v));
  const line = prefix + [...map].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
  if (idx >= 0) {
    lines[idx] = line;
  } else {
    const rtpmap = lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
    lines.splice(rtpmap + 1, 0, line);
  }
}

function opusParams({ music, audioKbps }) {
  return music
    ? { stereo: 1, 'sprop-stereo': 1, maxaveragebitrate: audioKbps * 1000, useinbandfec: 1, usedtx: 0 }
    : { minptime: 10, useinbandfec: 1, maxaveragebitrate: audioKbps * 1000 };
}

// Viewer offer: tell the server we can play stereo Opus.
export function tuneViewerOffer(sdp) {
  return editMedia(sdp, 'audio', (lines) => {
    for (const pt of payloadTypes(lines, /^opus$/i)) mergeFmtp(lines, pt, { stereo: 1, 'sprop-stereo': 1 });
  });
}

export function tunePublisherOffer(sdp, opts) {
  return editMedia(sdp, 'audio', (lines) => {
    for (const pt of payloadTypes(lines, /^opus$/i)) mergeFmtp(lines, pt, opusParams(opts));
  });
}

// Publisher answer: Chrome reads send-side limits from the remote description.
// x-google-start-bitrate skips the slow ramp-up so the first seconds are
// already sharp instead of starting at ~300 kbps and climbing.
export function tunePublisherAnswer(sdp, { videoKbps, music, audioKbps }) {
  let out = editMedia(sdp, 'video', (lines) => {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith('b=')) lines.splice(i, 1);
    const c = lines.findIndex((l) => l.startsWith('c='));
    lines.splice(c + 1, 0, `b=AS:${videoKbps}`, `b=TIAS:${videoKbps * 1000}`);
    for (const pt of payloadTypes(lines, /^(H264|VP8|VP9|AV1|H265)$/i)) {
      mergeFmtp(lines, pt, {
        'x-google-start-bitrate': Math.round(videoKbps * 0.7),
        'x-google-min-bitrate': Math.round(videoKbps * 0.25),
        'x-google-max-bitrate': videoKbps,
      });
    }
  });
  out = editMedia(out, 'audio', (lines) => {
    for (const pt of payloadTypes(lines, /^opus$/i)) mergeFmtp(lines, pt, opusParams({ music, audioKbps }));
  });
  return out;
}
