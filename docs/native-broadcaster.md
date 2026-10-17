# Dhamri CMD broadcaster — H.264 and HEVC

**A Windows command-line companion for the existing [Dhamri website](https://dhamri.vercel.app/).** It captures/encodes locally, publishes over encrypted WebRTC, and lets viewers keep watching in their browsers. No OBS is required. This is an optional native publisher; browser broadcasting remains available.

## Quick start / التشغيل

Download the Windows ZIP from [GitHub Releases](https://github.com/Akak0o0y/bth-aldhamri-club/releases), extract it, and open CMD inside the extracted folder. On the broadcasting laptop:

```bat
setup-dhamri.cmd
```

This installs Node.js LTS and Gyan FFmpeg through Windows Package Manager. **Reopen CMD** after installation so the new PATH is loaded. If those dependencies are already installed, skip setup. No `npm install` is needed for the companion.

```bat
dhamri doctor --codec hevc
dhamri benchmark --codec hevc
dhamri login
dhamri start --codec hevc
```

سجّل الدخول بنفس حساب المذيع في الموقع. يعرض البرنامج رابط قناتك للمشاهدين. الأمر الأخير يبث **الشاشة كاملة**؛ اضغط `Ctrl+C` للإيقاف. شغّل الاختبار على اللابتوب المطلوب نفسه. نجاح الاختبار المحلي لا يثبت سرعة الإنترنت أو وصول 60 إطاراً للمشاهد.

The release ZIP includes the small HEVC transport executable. GitHub's automatically generated **Source code ZIP** does not include compiled binaries: source users must run `tools\dhamri\build-native.cmd` with Go installed to use HEVC. H.264 uses FFmpeg's WHIP muxer directly.

## Quality and source selection

Defaults: **2560×1440 at a capture ceiling of 60 fps**, H.264 at 18 Mbps, or HEVC at 12 Mbps when `--codec hevc` is selected. These are starting bitrates, not measured upload capacity or promises of equivalent quality. HEVC can reduce the bitrate required for comparable quality, but compression efficiency depends on the encoder and content.

```bat
dhamri benchmark --codec hevc --seconds 30 --report hevc-result.json
dhamri start --codec hevc --bitrate 12000 --monitor 0
dhamri start --codec h264 --bitrate 18000
dhamri start --codec hevc --file "C:\Videos\match.mp4"
dhamri start --source test --codec hevc --seconds 30
```

- `doctor` performs real short encode probes; the presence of an encoder name in FFmpeg is insufficient.
- Auto selection tries NVIDIA NVENC, Intel Quick Sync, then AMD AMF. Incompatible drivers are reported. CPU encoding is only used when explicitly selected with `--encoder software`.
- `benchmark` defaults to a moving synthetic source and publishes nothing. Its result measures local encoding against wall time after warm-up, including a minimum three-second window. It is not a network, viewer, color-accuracy, or game-under-load test.
- `benchmark --source desktop` measures capture plus encoding locally. Keep moving content visible. Idle desktops legitimately produce fewer frames because duplicate-frame padding is disabled.
- A source smaller than the requested output is refused by default. Use a native 1440p display/video, select its actual size with `--size`, or explicitly `--allow-upscale`. Upscaling creates no additional detail.
- A 30 fps source stays 30 fps. The program does not manufacture intermediate motion frames to display a 60 counter. Higher requested frame rates also need a source and encoder that can supply them.
- Direct3D desktop capture is used. Compatible AMD drivers can also perform explicit color conversion on the GPU. If that path fails its probe, conversion/scaling uses the CPU while encoding remains on the selected GPU. This matters on older or mixed-GPU laptops.
- Desktop capture covers the selected monitor. `--file` accepts a local file, not a remote URL. Screen capture must run in a signed-in interactive Windows desktop session.

## HEVC viewer compatibility

`--codec hevc` sends actual H.265 Main-profile video and optional Opus audio through a native Pion WebRTC helper. It does not rename H.264 or use FFmpeg's H.264-only WHIP output for HEVC. No new public RTSP/SRT port is required on the existing MediaMTX server.

HEVC WebRTC decoding is not universal. Chrome/Edge need a compatible platform, GPU, driver, and browser configuration; other viewers may not support it. Inspect the browser's advertised capabilities:

```js
RTCRtpReceiver.getCapabilities('video').codecs.filter(c => c.mimeType === 'video/H265')
```

If a viewer cannot negotiate/play HEVC, restart the broadcast with `--codec h264`. MediaMTX forwards the codec; it does **not** transcode HEVC into H.264 for incompatible viewers. The default remains H.264 for broader compatibility.

## Audio and colors

**Desktop audio is off by default.** List capture devices and choose the exact name:

```bat
dhamri devices
dhamri start --codec hevc --audio "Stereo Mix (Realtek(R) Audio)"
```

A microphone captures the microphone. Capturing game/system sound requires Stereo Mix or another DirectShow loopback capture device provided by your system. The tool does not install virtual audio drivers or enable devices. `--file` includes the file's audio automatically when present. System loopback capture without a DirectShow device is not included in this version.

The pipeline uses SDR BT.709, 8-bit 4:2:0, explicitly converting full-range desktop RGB to limited-range video before marking the stream's color metadata. There is no saturation/contrast enhancement. Turn Windows HDR off for desktop capture; automatic HDR tone mapping and ICC/display calibration are not implemented. HDR files are refused. Colors can still differ with source rendering, compression and the viewer's display.

## Tailscale (optional)

Tailscale is a network route, separate from GPU encoding. Install/sign in to Tailscale on both the broadcaster and the **existing media server** if you want to test that route. This companion does not install Tailscale, modify your tailnet, or change server/firewall settings.

```bat
dhamri network --tailscale-peer 100.70.80.90
dhamri start --codec hevc --tailscale-peer 100.70.80.90
```

Replace the sample address with the media server's actual Tailscale IPv4. `network` runs a bounded Tailscale ping; prefer a **direct** connection rather than DERP/relay. It does not measure upload throughput.

Signaling/login still use the configured public HTTPS services. The explicit flag directs publisher UDP media to the supplied tailnet address, using the UDP port advertised by MediaMTX. The server must listen on that interface, and its firewall/Tailscale grants must permit that traffic (normally UDP 8189 with `server/gulf/setup.sh`). Public viewers continue using the public server address. Neither the server nor Tailscale is configured automatically. The flag cannot make an unrelated tailnet IP into a media server.

## Latency, bandwidth and 8 GB laptops

The native path uses no B frames, short encoder buffers, a one-second keyframe interval, small RTP packets and UDP WebRTC. These settings reduce buffering, but **fixed 1440p60 and below-one-second end-to-end latency are not guaranteed**. Source rendering, scaling, encoder, upload, server routing and viewer decoding must all keep up.

This release uses a **fixed bitrate and has no automatic congestion adaptation**. Start below sustained available upload with headroom for audio, RTP and retransmissions. Lower `--bitrate` if the viewer loses frames/freezes, or choose a lower resolution. HEVC and Tailscale cannot turn a roughly 1 Mbps available path into a reliable high-quality 1440p60 stream. The earlier browser reading of 0.9 Mbps was an encoder target, not an ISP speed test.

RAM capacity alone does not determine success. Test the actual 8 GB laptop while its intended game/video is running. Measure the viewer's decoded frames and use a visible source clock to compare end-to-end delay; the CLI's publisher FPS and HTTPS request time are not glass-to-glass measurements.

## Account handling

Login uses the same account API as the website. The password is prompted without echo and never saved or placed on a process command line. The returned session token is encrypted with Windows DPAPI for the current Windows user in `%LOCALAPPDATA%\Dhamri\session.json`. `dhamri logout` removes it locally; it does not revoke other device sessions.

The bundled DPAPI PowerShell helper runs with a process-only execution-policy setting so it can work after downloading the ZIP. It does not change the machine/user policy and cannot override organizational Group Policy.

An ephemeral loopback signaling proxy attaches the token to verified HTTPS requests. FFmpeg and the native helper receive a per-run loopback URL, not the account token. It rejects browser-origin requests and cross-origin redirects/session locations and cleans up the WHIP resource when the process exits. There is no local network-wide listener. Logins are bound to their account/media server pair.

## Development and checks

```bat
npm test
npm run lint
npm run build
tools\dhamri\build-native.cmd
cd tools\dhamri\native
go test ./...
```

`tests/native-whip.cjs` is an optional real-media test with a separate loopback-only MediaMTX process, a native publisher and headless Chrome viewer. Set `DHAMRI_MEDIAMTX` to a MediaMTX executable and `MAJLIS_PLAYWRIGHT` to an installed Playwright package. `MAJLIS_CHROME` can specify Chrome; `DHAMRI_CODEC=hevc` selects HEVC. It verifies negotiated codec, decoded 1440p frames, rendered video and session cleanup. Its reported playback FPS is evidence, not an unconditional 60 fps assertion.

Set `DHAMRI_AUDIO_TEST=1` to verify Opus audio too. `DHAMRI_CLI_TEST=1` exercises saved login and file playback through the actual CLI against a separate local account stub; `DHAMRI_CLI_ENTRY` can point to an extracted release's `tools/dhamri/cli.mjs`. Test tokens and sessions stay in a temporary directory. Set `DHAMRI_FFMPEG_TEST=ffmpeg` when running `npm test` to include the real 30/60/120 fps regression check; without FFmpeg that one test is skipped.

References: [FFmpeg WHIP](https://ffmpeg.org/ffmpeg-formats.html#whip), [desktop capture](https://ffmpeg.org/ffmpeg-filters.html#ddagrab), [MediaMTX WebRTC compatibility](https://mediamtx.org/docs/features/webrtc-specific-features), [Pion WebRTC](https://github.com/pion/webrtc), [Tailscale connection types](https://tailscale.com/docs/reference/connection-types).
