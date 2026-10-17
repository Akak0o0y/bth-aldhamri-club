#!/usr/bin/env node
import { access, writeFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { totalmem } from 'node:os';
import { parseArgs, settings, ENCODERS, HEVC_ENCODERS, encoderName, hevcLevel, ffmpegArgs, desktopInput, summarize, watchUrl, tailscaleIp } from './core.mjs';
import { run, failureDetail } from './process.mjs';
import { prompt, loginRequest, saveSession, loadSession, sessionPath } from './auth.mjs';
import { createWhipProxy } from './proxy.mjs';
import { startHevcBridge } from './bridge.mjs';
import { startControlHost } from './control-host.mjs';
import { launchViewer } from './viewer.mjs';

const HELP = `Dhamri native broadcaster for Windows 10/11

  dhamri doctor                       Check FFmpeg and real GPU encoder support
  dhamri benchmark                    20-second local 2560x1440 / 60 fps test
  dhamri benchmark --codec hevc        Test hardware HEVC encoding at 12 Mbps
  dhamri login                        Sign in with your website broadcaster account
  dhamri start                        Broadcast desktop monitor 0 to your channel
  dhamri start --codec hevc            HEVC for compatible viewer browsers/GPUs
  dhamri start --file "video.mp4"       Broadcast a local SDR video, including audio
  dhamri start --source test           Broadcast the moving synthetic test pattern
  dhamri start --codec hevc --allow-control   Let a viewer request mouse/keyboard control
  dhamri watch --room majlis           Open the separate desktop viewer window
  dhamri watch --room majlis --control Sign in first, then request streamer approval
  dhamri devices                      List DirectShow audio capture devices
  dhamri network                      Check HTTPS signaling reachability
  dhamri logout                       Remove this computer's saved login

Quality options:
  --size 2560x1440   --fps 60   --bitrate 18000  (kbps)
  --codec h264|hevc  (HEVC defaults to 12000 kbps at 1440p)
  --encoder auto|nvenc|qsv|amf|software
  --monitor 0       --audio "Exact DirectShow device name"
  --seconds 20      --ffmpeg "C:\\path\\to\\ffmpeg.exe"
  --allow-upscale   Explicitly permit enlarging a smaller source
  --report result.json   Save a benchmark report; --json prints JSON only

Control is off by default. The streamer must type the displayed APPROVE code
for each session. Ctrl+Alt+F10 or the visible Stop control button revokes it.
Viewer Esc, switching windows, disconnects and a 10-minute limit also revoke.
This version supports a single active laptop display; disconnect other screens.
The desktop viewer uses an isolated Edge/Chrome app window, not the website.

Network options:
  --server https://media.example.com   --relay https://accounts.example.com
  --tailscale-peer 100.x.x.x   Server's existing Tailscale IPv4 (start/network)

Ctrl+C stops broadcasting. Watching continues at https://dhamri.vercel.app/
Desktop audio is OFF unless --audio is supplied. Use Stereo Mix or a loopback
capture device for game sound; --file uses the file's own audio.
This is an SDR BT.709 tool. Turn off Windows HDR for desktop capture.
No OBS, npm install, or browser encoder is required. Node.js 22+ and FFmpeg with
ddagrab and hardware encoders are required (setup-dhamri.cmd). H.264 also needs
FFmpeg's WHIP muxer; HEVC uses the included transport helper.
60 fps and sub-second delivery depend on the source, GPU, uplink and viewer.
`;

function abortable() {
  const controller = new AbortController();
  const handler = () => controller.abort();
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return { signal: controller.signal, cancel: handler, dispose() { process.off('SIGINT', handler); process.off('SIGTERM', handler); } };
}

async function capabilities(binary, codec = 'h264') {
  let results;
  try {
    results = await Promise.all([
      run(binary, ['-hide_banner', '-version']),
      run(binary, ['-hide_banner', '-muxers']),
      run(binary, ['-hide_banner', '-encoders']),
      run(binary, ['-hide_banner', '-filters']),
    ]);
  } catch { throw new Error('FFmpeg could not start. Run setup-dhamri.cmd and reopen CMD, or supply --ffmpeg.'); }
  if (results.some(r => r.code !== 0)) throw new Error('FFmpeg capability check failed. Check your installation.');
  const combined = result => result.stdout + result.stderr;
  return {
    version: combined(results[0]).split(/\r?\n/)[0],
    whip: /\bwhip\s/.test(combined(results[1])),
    encoders: Object.entries(codec === 'hevc' ? HEVC_ENCODERS : ENCODERS).filter(([, name]) => new RegExp(`\\b${name}\\s`).test(combined(results[2]))).map(([key]) => key),
    ddagrab: /\bddagrab\s/.test(combined(results[3])),
    vppAmf: /\bvpp_amf\s/.test(combined(results[3])),
  };
}

async function probeEncoder(binary, config, encoder, signal) {
  let frames = 0;
  const result = await run(binary, ffmpegArgs(config, encoder, { probe: true }), {
    timeout: 20000, signal, onProgress: sample => { frames = sample.frame; },
  });
  return { encoder, available: result.code === 0 && frames >= 12 && !result.timedOut && !result.cancelled, reason: result.code === 0 && frames >= 12 ? null : failureDetail(result) };
}

async function selectEncoder(binary, config, caps, signal, log) {
  const names = config.encoder === 'auto' ? ['nvenc', 'qsv', 'amf'] : [config.encoder];
  for (const encoder of names) {
    if (signal.aborted) throw new Error('Cancelled.');
    if (!caps.encoders.includes(encoder)) { log(`${encoder}: not included in this FFmpeg build.`); continue; }
    const result = await probeEncoder(binary, config, encoder, signal);
    if (result.available) { log(`Encoder: ${encoderName(config, encoder)} (${encoder === 'software' ? 'CPU, explicitly selected' : 'hardware probe passed'}).`); return encoder; }
    log(`${encoder}: ${result.reason}`);
  }
  throw new Error('No requested hardware encoder passed. Check the GPU driver/FFmpeg compatibility, or explicitly choose --encoder software for a CPU test.');
}

async function sourceInfo(binary, config, signal) {
  if (config.source === 'test') return { width: config.width, height: config.height, fps: config.fps, synthetic: true };
  if (config.source === 'desktop') {
    const result = await run(binary, ['-hide_banner', '-f', 'lavfi', '-i', `${desktopInput(config, true)},hwdownload,format=bgra`, '-frames:v', '1', '-an', '-f', 'null', '-'], { timeout: 12000, signal });
    const dimensions = /Video:.*?\b(\d{3,5})x(\d{3,5})\b/.exec(result.stderr);
    if (result.code !== 0 || !dimensions) throw new Error('Desktop capture could not initialize. Check --monitor, and run in a signed-in Windows desktop session.');
    return { width: Number(dimensions[1]), height: Number(dimensions[2]), fps: null, synthetic: false };
  }
  const localFile = await stat(config.file).catch(() => null);
  if (!localFile?.isFile()) throw new Error('--file must name an existing local video file.');
  config.file = resolve(config.file);
  const probe = dirname(binary) === '.' ? 'ffprobe' : join(dirname(binary), 'ffprobe.exe');
  const result = await run(probe, ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,color_transfer,color_space,color_range', '-of', 'json', config.file], { signal });
  if (result.code !== 0) throw new Error('Could not inspect the video. FFprobe must be installed beside FFmpeg.');
  const streams = JSON.parse(result.stdout).streams || [];
  const stream = streams.find(s => s.codec_type === 'video');
  if (!stream?.width || !stream?.height) throw new Error('The file contains no supported video stream.');
  if (['smpte2084', 'arib-std-b67'].includes(stream.color_transfer)) throw new Error('This file is HDR. Convert it to SDR with proper tone mapping before broadcasting.');
  const rate = stream.avg_frame_rate?.split('/').map(Number);
  return { width: stream.width, height: stream.height, fps: rate?.[1] ? rate[0] / rate[1] : null, synthetic: false, hasAudio: streams.some(s => s.codec_type === 'audio') };
}

async function selectPipeline(binary, config, encoder, caps, info, signal, log) {
  if (config.source !== 'desktop') return 'copy';
  if (encoder === 'amf' && caps.vppAmf && info.width * config.height === info.height * config.width) {
    const args = ffmpegArgs({ ...config, seconds: 1, audio: null }, encoder, { pipeline: 'gpu' });
    const inputAt = args.indexOf('-i');
    args[inputAt + 1] = desktopInput(config, true);
    const result = await run(binary, args, { timeout: 8000, signal });
    if (result.code === 0 && !result.timedOut && !result.cancelled) {
      log('Capture/conversion: D3D11 + AMD GPU color conversion.'); return 'gpu';
    }
    log('GPU color conversion unavailable on this driver; using explicit BT.709 conversion with hardware encoding.');
  }
  log('Capture: D3D11. Color conversion/scaling: CPU. Encoding: ' + (encoder === 'software' ? 'CPU.' : 'GPU.'));
  return 'copy';
}

async function emitReport(report, options) {
  if (options.report) {
    await writeFile(resolve(options.report), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    if (!options.json) console.log(`Report saved: ${resolve(options.report)}`);
  }
  if (options.json) console.log(JSON.stringify(report, null, 2));
}

async function broadcastOrBenchmark(command, options, binary) {
  const config = settings(options, command);
  const log = options.json ? () => {} : console.log;
  const abort = abortable();
  let proxy, bridge, bridgeError, controlHost;
  try {
    let session;
    if (command === 'start') {
      session = await loadSession(options);
      config.server = session.server;
      config.relay = session.relay;
    }
    const caps = await capabilities(binary, config.codec);
    if (command === 'start' && config.codec === 'h264' && !caps.whip) throw new Error('This FFmpeg build has no WHIP muxer. Install a current full build with WHIP support.');
    if (config.source === 'desktop' && !caps.ddagrab) throw new Error('This FFmpeg build has no ddagrab desktop capture filter.');
    const info = await sourceInfo(binary, config, abort.signal);
    const upscaled = info.width < config.width || info.height < config.height;
    log(`Source: ${config.source}, ${info.width}x${info.height}${info.fps ? ` / ${info.fps.toFixed(1)} fps` : ''}. Target: ${config.size} / ${config.fps} fps, ${config.bitrate / 1000} Mbps.`);
    if (upscaled && !config.allowUpscale) throw new Error(`Source is only ${info.width}x${info.height}. Use --size ${info.width}x${info.height}, a native ${config.size} source, or explicitly --allow-upscale (adds no detail).`);
    if (upscaled) log('Upscaling a smaller source: this does not create native 2K detail.');
    if (info.fps && info.fps < config.fps - 1) log(`The source is ${info.fps.toFixed(1)} fps. Frames will not be duplicated to claim ${config.fps} fps.`);
    const encoder = await selectEncoder(binary, config, caps, abort.signal, log);
    const pipeline = await selectPipeline(binary, config, encoder, caps, info, abort.signal, log);
    if (abort.signal.aborted) throw new Error('Cancelled.');
    if (command === 'start') {
      const endpoint = `${config.server}/${encodeURIComponent(session.room)}/whip?session=${randomUUID()}`;
      proxy = await createWhipProxy({ endpoint, token: session.token, tailscalePeer: config.tailscalePeer, onStatus: log });
      if (config.codec === 'hevc') {
        log('HEVC requires compatible viewer hardware/browser. Use --codec h264 if a viewer cannot play it.');
        bridge = await startHevcBridge({ endpoint: proxy.url, audio: Boolean(config.audio || info.hasAudio), level: hevcLevel(config), signal: abort.signal, onFailure: error => { bridgeError = error; abort.cancel(); } });
      }
      log(`Watch: ${watchUrl(session.room)}`);
      log(`Starting ${config.source === 'desktop' ? `capture of entire monitor ${config.monitor}` : config.source}. Ctrl+C stops it.`);
      log('Audio: ' + (config.audio ? config.audio : config.source === 'file' ? 'from video file, if present' : 'OFF (use --audio to select a capture device)'));
      log('Native WHIP uses UDP and a fixed bitrate; it does not adapt to congestion. Lower --bitrate if the viewer freezes or drops frames.');
      if (options['allow-control']) controlHost = await startControlHost({ session, info, signal: abort.signal, log });
    } else log(`Running ${config.seconds}s locally. No media will be uploaded.`);

    const samples = [];
    let lastDisplay = 0;
    const result = await run(binary, ffmpegArgs(config, encoder, { endpoint: bridge ? undefined : proxy?.url, rtp: bridge, pipeline }), {
      signal: abort.signal, timeout: config.seconds ? (config.seconds * 3 + 20) * 1000 : 0,
      onProgress: sample => {
        samples.push(sample);
        if (samples.length > 3605) samples.shift();
        if (sample.elapsed - lastDisplay >= 2) {
          const previous = samples.find(s => sample.elapsed - s.elapsed <= 3.2 && sample.elapsed - s.elapsed >= 2);
          const fps = previous ? (sample.frame - previous.frame) / (sample.elapsed - previous.elapsed) : sample.fps;
          log(`Encoded ${fps.toFixed(1)} fps | ${sample.frame} frames | dropped ${sample.drop_frames || 0} | duplicated ${sample.dup_frames || 0}`);
          lastDisplay = sample.elapsed;
        }
      },
    });
    const summary = summarize(samples, config, { exitCode: result.code, cancelled: result.cancelled || result.timedOut });
    const report = { ...summary, codec: config.codec, encoder: encoderName(config, encoder), pipeline, sourceDimensions: `${info.width}x${info.height}`, upscaled, ffmpeg: caps.version, ramGiB: Math.round(totalmem() / 1024 ** 3), cancelled: result.cancelled, timedOut: result.timedOut };
    if (command === 'benchmark') {
      log(`${summary.passed ? 'PASS' : 'BELOW TARGET'}: average ${summary.encodedFps ?? '?'} encoded fps; minimum 3-second window ${summary.minimumWindowFps ?? '?'} fps.`);
      log(summary.scope);
      await emitReport(report, options);
      if (!summary.passed) process.exitCode = 2;
    }
    if (command === 'start' && (options.report || options.json)) await emitReport({ ...report, scope: 'Publisher encoding counters only; viewer delivery and end-to-end latency are not measured.' }, options);
    if (bridgeError) throw bridgeError;
    if (result.timedOut) throw new Error('Encoding timed out. The process was stopped.');
    if (result.code !== 0 && !result.cancelled) throw new Error(`${failureDetail(result)} Check UDP reachability, GPU driver, audio device, and whether another broadcast is using the channel.`);
    if (command === 'start') log('Broadcast stopped.');
  } finally { controlHost?.close(); await bridge?.close(); await proxy?.close(); abort.dispose(); }
}

async function doctor(options, binary) {
  const log = options.json ? () => {} : console.log;
  const config = settings(options, 'doctor');
  const caps = await capabilities(binary, config.codec);
  log(caps.version);
  log(`RAM: ${Math.round(totalmem() / 1024 ** 3)} GiB. WHIP: ${caps.whip ? 'yes' : 'missing'}. Desktop capture: ${caps.ddagrab ? 'yes' : 'missing'}.`);
  const abort = abortable();
  const probes = [];
  try {
    for (const encoder of ['nvenc', 'qsv', 'amf']) {
      if (abort.signal.aborted) break;
      const result = caps.encoders.includes(encoder) ? await probeEncoder(binary, config, encoder, abort.signal) : { encoder, available: false, reason: 'Not included in FFmpeg.' };
      probes.push(result);
      log(`${encoder}: ${result.available ? 'hardware encode succeeded' : result.reason}`);
    }
  } finally { abort.dispose(); }
  log('Next: dhamri benchmark. A working encoder is not yet a 60 fps performance result.');
  await emitReport({ ...caps, probes, ramGiB: Math.round(totalmem() / 1024 ** 3) }, options);
  if ((config.codec === 'h264' && !caps.whip) || !caps.ddagrab || !probes.some(p => p.available)) process.exitCode = 2;
}

async function network(options) {
  const config = settings(options);
  const started = performance.now();
  const response = await fetch(config.server, { method: 'OPTIONS', redirect: 'error', signal: AbortSignal.timeout(12000) });
  await response.body?.cancel();
  console.log(`HTTPS signaling responded (HTTP ${response.status}) in ${Math.round(performance.now() - started)} ms. This is NOT an upload-speed or media-latency test.`);
  if (config.tailscalePeer) {
    let binary = 'tailscale.exe';
    const installed = join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
    try { await access(installed); binary = installed; } catch { /* Try PATH. */ }
    const result = await run(binary, ['ping', '--c', '3', '--until-direct=false', tailscaleIp(config.tailscalePeer)], { timeout: 20000 });
    console.log((result.stdout + result.stderr).trim());
    if (result.code !== 0) throw new Error('Tailscale peer check failed. Sign in to the same tailnet on the laptop and media server.');
    console.log('Prefer a direct path. DERP/relay is not proof of enough bandwidth for 1440p60.');
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'help') { console.log(HELP); return; }
  if (process.platform !== 'win32') throw new Error('The native companion currently supports Windows 10/11.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const binary = options.ffmpeg || 'ffmpeg';
  if (command === 'watch') {
    const config = settings(options, 'watch');
    const session = options.control ? await loadSession(options) : undefined;
    if (session) { config.server = session.server; config.relay = session.relay; }
    return launchViewer({ config, session });
  }
  if (command === 'doctor') return doctor(options, binary);
  if (command === 'benchmark' || command === 'start') return broadcastOrBenchmark(command, options, binary);
  if (command === 'network') return network(options);
  if (command === 'devices') {
    const result = await run(binary, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
    console.log(result.stderr);
    console.log('For desktop/game audio, select a Stereo Mix or loopback device if your system provides one.');
    return;
  }
  if (command === 'logout') { await rm(sessionPath(), { force: true }); console.log('Saved login removed.'); return; }
  const config = settings(options);
  console.log(`Signing in at ${config.relay}. The login is bound to media server ${config.server}.`);
  const name = options.user || await prompt('Broadcaster username: ');
  const pass = await prompt('Password (hidden): ', true);
  const session = await loginRequest(config.relay, name, pass);
  await saveSession(session, config);
  console.log(`Signed in as ${session.name}. Watch link: ${watchUrl(session.room)}\nRun dhamri start to broadcast. Password is not saved; the session token is encrypted for your Windows user.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Dhamri: ${error.message}`); process.exitCode = 1; });
}
