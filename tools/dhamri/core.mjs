import { isIP } from 'node:net';

export const DEFAULT_SERVER = 'https://145-241-106-1.sslip.io';
export const DEFAULT_RELAY = 'https://realtime-production-988e.up.railway.app';
export const WEBSITE = 'https://dhamri.vercel.app/';
export const ENCODERS = { nvenc: 'h264_nvenc', qsv: 'h264_qsv', amf: 'h264_amf', software: 'libx264' };
export const HEVC_ENCODERS = { nvenc: 'hevc_nvenc', qsv: 'hevc_qsv', amf: 'hevc_amf', software: 'libx265' };
export const encoderName = (config, encoder) => (config.codec === 'hevc' ? HEVC_ENCODERS : ENCODERS)[encoder];
export function hevcLevel(config) {
  const pixels = config.width * config.height;
  return pixels * config.fps <= 267386880 ? 150 : pixels * config.fps <= 534773760 ? 153 : 156;
}
const VALUES = new Set(['size', 'fps', 'bitrate', 'codec', 'encoder', 'source', 'file', 'monitor', 'audio', 'seconds', 'ffmpeg', 'server', 'relay', 'user', 'tailscale-peer', 'report']);
const FLAGS = new Set(['help', 'json', 'allow-upscale']);
const COMMANDS = new Set(['help', 'doctor', 'devices', 'benchmark', 'login', 'logout', 'start', 'network']);

export function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'help';
  if (!COMMANDS.has(command)) throw new Error(`Unknown command: ${command}. Run dhamri help.`);
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!key.startsWith('--') || key.includes('=')) throw new Error(`Use --option value; unexpected argument: ${key}`);
    const name = key.slice(2);
    if (Object.hasOwn(options, name)) throw new Error(`Repeated option: ${key}`);
    if (FLAGS.has(name)) options[name] = true;
    else if (VALUES.has(name)) {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[name] = value;
    } else throw new Error(`Unknown option: ${key}`);
  }
  return { command: options.help ? 'help' : command, options };
}

function integer(value, min, max, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return n;
}

export function secureUrl(value) {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) {
    throw new Error('Use an HTTPS server URL without credentials, query, or fragment (HTTP is allowed on localhost for development).');
  }
  return url.href.replace(/\/+$/, '');
}

export function tailscaleIp(value) {
  const parts = value?.split('.').map(Number);
  if (isIP(value || '') !== 4 || parts[0] !== 100 || parts[1] < 64 || parts[1] > 127) {
    throw new Error('--tailscale-peer must be the media server\'s Tailscale IPv4 address (100.64.0.0/10).');
  }
  return value;
}

export function settings(options, command = 'start') {
  const size = options.size || '2560x1440';
  if (!/^\d{3,4}x\d{3,4}$/.test(size)) throw new Error('--size must look like 2560x1440.');
  const [width, height] = size.split('x').map(Number);
  if (width < 320 || height < 180 || width > 3840 || height > 2160 || width % 2 || height % 2) throw new Error('Use even dimensions, from 320x180 up to 3840x2160.');
  const source = options.file ? 'file' : options.source || (command === 'benchmark' || command === 'doctor' ? 'test' : 'desktop');
  if (!['desktop', 'test', 'file'].includes(source) || (source === 'file' && !options.file)) throw new Error('Use --source desktop, --source test, or --file "local video.mp4".');
  if (options.file && options.source && options.source !== 'file') throw new Error('--file cannot be combined with a different --source.');
  const encoder = options.encoder || 'auto';
  if (encoder !== 'auto' && !Object.hasOwn(ENCODERS, encoder)) throw new Error('--encoder must be auto, nvenc, qsv, amf, or software.');
  const fps = integer(options.fps || 60, 15, 120, 'FPS');
  const codec = options.codec || 'h264';
  if (!['h264', 'hevc'].includes(codec)) throw new Error('--codec must be h264 or hevc.');
  const defaultBitrate = height >= 1440 ? (codec === 'hevc' ? 12000 : 18000) : height >= 1080 ? (codec === 'hevc' ? 6000 : 9000) : 4500;
  const bitrate = integer(options.bitrate || defaultBitrate, 500, 50000, 'Bitrate (kbps)');
  const seconds = integer(options.seconds || (command === 'benchmark' ? 20 : 0), command === 'benchmark' ? 10 : 0, 3600, 'Seconds');
  if (options.audio && source === 'file') throw new Error('File streams use the audio in the file; omit --audio.');
  return {
    width, height, size, fps, bitrate, codec, source, encoder, seconds,
    monitor: integer(options.monitor || 0, 0, 31, 'Monitor index'),
    file: options.file, audio: options.audio || null,
    allowUpscale: Boolean(options['allow-upscale']),
    server: secureUrl(options.server || DEFAULT_SERVER),
    relay: secureUrl(options.relay || DEFAULT_RELAY),
    tailscalePeer: options['tailscale-peer'] ? tailscaleIp(options['tailscale-peer']) : null,
  };
}

export function encoderArgs(config, encoder) {
  const hevc = config.codec === 'hevc';
  const base = ['-c:v', encoderName(config, encoder), '-b:v', `${config.bitrate}k`, '-maxrate', `${config.bitrate}k`, '-bufsize', `${Math.ceil(config.bitrate / 6)}k`, '-g', String(config.fps), '-bf', '0'];
  if (encoder === 'nvenc') base.push('-preset', 'p4', '-tune', 'ull', '-rc', 'cbr', '-rc-lookahead', '0', '-zerolatency', '1', '-profile:v', hevc ? 'main' : 'baseline');
  else if (encoder === 'qsv') base.push('-preset', 'veryfast', '-look_ahead', '0', '-async_depth', '1', '-low_delay_brc', '1', '-profile:v', hevc ? 'main' : 'baseline');
  else if (encoder === 'amf') base.push('-usage', 'ultralowlatency', '-quality', 'balanced', '-rc', 'cbr', '-async_depth', '1', '-profile:v', hevc ? 'main' : 'constrained_baseline');
  else base.push('-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', hevc ? 'main' : 'baseline');
  return [...base, '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];
}

export function desktopInput(config, duplicate = false) {
  return `ddagrab=output_idx=${config.monitor}:framerate=${config.fps}:draw_mouse=1:dup_frames=${duplicate ? 1 : 0}:output_fmt=bgra`;
}

export function ffmpegArgs(config, encoder, { endpoint, rtp, probe = false, pipeline = 'copy' } = {}) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-stats_period', '1', '-progress', 'pipe:1', '-filter_threads', '2'];
  const source = probe ? 'test' : config.source;
  if (source === 'test') {
    if (!probe) args.push('-readrate', '1', '-readrate_initial_burst', '0');
    args.push('-f', 'lavfi', '-i', `testsrc2=size=${config.size}:rate=${config.fps}`);
  } else if (source === 'desktop') {
    args.push('-f', 'lavfi', '-i', desktopInput(config) + (pipeline === 'gpu' ? '' : ',hwdownload,format=bgra'));
  } else args.push('-readrate', '1', '-readrate_initial_burst', '0', '-i', config.file);

  if (!probe && config.audio) args.push('-thread_queue_size', '8', '-f', 'dshow', '-audio_buffer_size', '50', '-i', `audio=${config.audio}`);
  args.push('-map', '0:v:0');
  if (!rtp && !probe && config.audio) args.push('-map', '1:a:0');
  else if (!rtp && !probe && source === 'file') args.push('-map', '0:a:0?');
  else args.push('-an');

  if (source === 'desktop' && pipeline === 'gpu') {
    // AMD's converter explicitly controls RGB full -> BT.709 limited on GPU.
    // Unsupported drivers are detected by a real encode probe before publishing.
    args.push('-vf', `vpp_amf=w=${config.width}:h=${config.height}:format=nv12:color_profile=bt709:in_color_range=full:out_color_range=studio`);
  } else if (source !== 'test') {
    const range = source === 'desktop' ? ':in_range=pc' : '';
    // Drop frames only when they fall in the same target time slot. Preserve
    // timestamps and lower source rates; -fpsmax requires CFR and duplicates
    // slower input. Rounded slots tolerate millisecond container timestamps.
    const ceiling = source === 'file' ? `select='isnan(prev_selected_t)+gt(floor(t*${config.fps}+0.5),floor(prev_selected_t*${config.fps}+0.5))',` : '';
    args.push('-vf', `${ceiling}scale=${config.width}:${config.height}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=bilinear:out_color_matrix=bt709:out_range=tv${range},pad=${config.width}:${config.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=nv12`);
  } else args.push('-vf', 'format=nv12');
  args.push(...encoderArgs(config, encoder), '-fps_mode', 'passthrough');
  if (!rtp && !probe && (config.audio || source === 'file')) args.push(...opusArgs());
  if (probe) args.push('-frames:v', '12');
  else if (config.seconds) args.push('-t', String(config.seconds));
  if (rtp) {
    if (config.codec !== 'hevc') throw new Error('The RTP bridge is reserved for HEVC.');
    args.push('-bsf:v', 'dump_extra=freq=keyframe', '-f', 'rtp', '-payload_type', '96', '-rtpflags', 'skip_rtcp', `rtp://127.0.0.1:${rtp.videoPort}?pkt_size=1100`);
    if (rtp.audioPort) {
      args.push('-map', config.audio ? '1:a:0' : '0:a:0', '-vn', ...opusArgs());
      if (config.seconds) args.push('-t', String(config.seconds));
      args.push('-f', 'rtp', '-payload_type', '111', '-rtpflags', 'skip_rtcp', `rtp://127.0.0.1:${rtp.audioPort}?pkt_size=1100`);
    }
  } else if (endpoint) {
    if (config.codec === 'hevc') throw new Error('HEVC requires the native bridge, not FFmpeg\'s H.264-only WHIP muxer.');
    args.push('-flags:v', '+global_header', '-strict', 'experimental', '-f', 'whip', '-handshake_timeout', '10000', '-timeout', '10', '-pkt_size', '1200', endpoint);
  }
  else args.push('-f', 'null', '-');
  return args;
}

const opusArgs = () => ['-c:a', 'libopus', '-ar', '48000', '-ac', '2', '-b:a', '128k', '-application', 'lowdelay', '-frame_duration', '10'];

export function summarize(samples, config, { exitCode = 0, cancelled = false } = {}) {
  const windows = [];
  // Count against monotonic wall time, not the requested FPS or media timestamps.
  const warm = samples.find(s => s.elapsed >= 3);
  const last = samples.at(-1);
  if (warm) {
    for (const end of samples.filter(s => s.elapsed >= warm.elapsed + 3)) {
      const begin = samples.find(s => s.elapsed >= warm.elapsed && end.elapsed - s.elapsed <= 3.2 && end.elapsed - s.elapsed >= 2.5);
      if (begin) windows.push((end.frame - begin.frame) / (end.elapsed - begin.elapsed));
    }
  }
  const average = warm && last && last.elapsed > warm.elapsed ? (last.frame - warm.frame) / (last.elapsed - warm.elapsed) : null;
  const min = windows.length ? Math.min(...windows) : null;
  const dropped = last?.drop_frames ?? 0;
  const duplicated = last?.dup_frames ?? 0;
  const enough = warm && last && last.elapsed - warm.elapsed >= 5;
  return {
    target: `${config.size} at ${config.fps} fps`, source: config.source,
    encodedFps: average == null ? null : Math.round(average * 10) / 10,
    minimumWindowFps: min == null ? null : Math.round(min * 10) / 10,
    frames: last?.frame ?? 0, dropped, duplicated,
    durationSeconds: last ? Math.round(last.elapsed * 10) / 10 : 0,
    passed: Boolean(!cancelled && exitCode === 0 && enough && average >= config.fps - 1 && min >= config.fps - 2 && dropped === 0 && duplicated === 0),
    scope: 'Local encoding only. Does not measure upload, viewer decoding, end-to-end latency, or game performance.',
  };
}

export function watchUrl(room) {
  const url = new URL(WEBSITE);
  url.searchParams.set('room', room);
  return url.href;
}
