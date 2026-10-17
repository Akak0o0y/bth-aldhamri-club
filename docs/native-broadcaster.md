# Dhamri CMD broadcaster and desktop viewer — H.264 and HEVC

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

The release ZIP includes the HEVC transport and Windows input helpers. GitHub's automatically generated **Source code ZIP** does not include compiled binaries: source users must run `tools\dhamri\build-native.cmd` with Go installed to use HEVC or remote control. H.264 uses FFmpeg's WHIP muxer directly.

## Desktop viewer and remote control / التحكم عن بعد

**Control from the website:** the viewer can now use [dhamri.vercel.app](https://dhamri.vercel.app/) instead of installing the desktop viewer. Open the streamer's channel link, sign in with your own account using **دخول للتحكم**, close the account dialog, and click **طلب التحكم** below the video. The streaming laptop still runs `dhamri start --codec hevc --allow-control` from the Windows ZIP and approves the displayed `APPROVE` command locally. A browser-only broadcaster cannot accept Windows input.

After approval, click inside the video to use the mouse and keyboard. **إيقاف التحكم** or Escape releases control; switching tabs/windows, pausing playback, signing out or disconnecting also stops it. Chat typing stays local. The streamer can always use Ctrl+Alt+F10. The website uses the same authenticated relay, ten-minute session limit and one-controller rule as the desktop viewer. A new session always requires a fresh request and local approval. No installation is needed on the website viewer's laptop.

`dhamri watch` opens a separate desktop app window using installed Microsoft Edge or Google Chrome and a temporary, isolated browser profile. Launch it from CMD; the Dhamri website is not needed during viewing or control. It uses the browser engine for WebRTC decoding, so HEVC still requires a compatible GPU, driver and browser. Node.js is required on both laptops; FFmpeg is needed only on the streaming laptop. Windows x64 is required for the native helpers.

On the **streaming laptop**, sign in with its own Dhamri account and opt into control requests:

```bat
dhamri login
dhamri start --codec hevc --allow-control
```

For a 1920×1080 laptop screen, specify its actual dimensions:

```bat
dhamri start --codec hevc --size 1920x1080 --allow-control
```

Use the default 2560×1440 target with a native 1440p screen. `--allow-upscale` can enlarge a smaller screen but adds no detail. This first control release requires **one active display**, monitor 0, desktop capture and an interactive terminal. Disconnect external displays before starting it. File and test-pattern broadcasts do not accept control.

On the **viewer's laptop**, sign in with the viewer's own account, then open the streamer's channel:

```bat
dhamri login
dhamri watch --room THEIR_CHANNEL --control
```

Replace `THEIR_CHANNEL` with the channel name from the streamer's watch link, for example `majlis`. The room is not necessarily their account name. The streamer can create an account invitation from the website if the viewer does not yet have an account. To watch without requesting control, no account is needed:

```bat
dhamri watch --room THEIR_CHANNEL
```

1. Once video appears, the viewer clicks **Request control**.
2. The streamer's terminal displays the viewer's signed-in account name and a fresh approval code. The streamer types the exact displayed command, such as `APPROVE A1B2C3`, and presses Enter within 30 seconds. `DENY` declines the request.
3. A visible **REMOTE CONTROL ACTIVE** window appears on the streaming laptop. The viewer clicks inside the video and can move the mouse, click, drag, scroll and type. Keys follow the streaming laptop's keyboard layout.
4. The streamer can revoke immediately with **Ctrl+Alt+F10**, the **Stop control** window button, or `STOP` + Enter in CMD. The viewer can press **Esc**, click **Stop control**, switch windows, or close the viewer. `Ctrl+C` in the broadcasting terminal stops the broadcast and control together.

Each grant lasts at most ten minutes, permits one controller, and requires fresh approval to start again. Disconnection and missing heartbeats revoke control and release held keys/buttons. A still desktop remains controllable even when capture emits no new frames. A stopped relay connection requires reopening the viewer or restarting the broadcaster before requesting again.

Control covers the Windows desktop using ordinary mouse/keyboard input. It does not provide clipboard synchronization, file transfer, unattended access, a remote command API, UAC secure-desktop control or input into elevated applications. Windows/browser-reserved shortcuts may stay local; Escape is reserved for stopping control. Run without administrator privileges. Streaming performance and the media codec are unchanged by enabling control.

Both sides authenticate over the dedicated `/control` WebSocket endpoint. With the desktop viewer, account tokens stay in the CLI, never in its viewer page or process arguments; the website viewer uses its existing signed-in browser session. The relay verifies channel ownership and the approved viewer, limits input rate, and rejects stale sessions. The local desktop viewer listens only on `127.0.0.1`, with a new private URL for each launch and strict Origin/Host checks. Input commands are relayed over WSS, so their delay depends on the realtime server route as well as the video route; this is not a measured gaming-latency guarantee.

**Server rollout:** remote control requires this version of `server/realtime.js` **and `server/control.js`** on the realtime service. Its health endpoint reports `controlProtocol: 1` when supported. Deploy from the repository's `server/` directory using its Dockerfile; retain the existing account volume, secrets and origins. No database migration or media-server update is required. Downloading the new ZIP alone does not upgrade an older relay. Ordinary broadcasting and viewing can continue with an older relay; `--allow-control` reports an error until the relay is updated.

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
node tests/control-relay.cjs
npm run lint
npm run build
tools\dhamri\build-native.cmd
cd tools\dhamri\native
go test ./...
```

`tests/native-whip.cjs` is an optional real-media test with a separate loopback-only MediaMTX process, a native publisher and headless Chrome viewer. Set `DHAMRI_MEDIAMTX` to a MediaMTX executable and `MAJLIS_PLAYWRIGHT` to an installed Playwright package. `MAJLIS_CHROME` can specify Chrome; `DHAMRI_CODEC=hevc` selects HEVC. It verifies negotiated codec, decoded 1440p frames, rendered video and session cleanup. Its reported playback FPS is evidence, not an unconditional 60 fps assertion.

Set `DHAMRI_AUDIO_TEST=1` to verify Opus audio too. `DHAMRI_CLI_TEST=1` exercises saved login and file playback through the actual CLI against a separate local account stub; `DHAMRI_CLI_ENTRY` can point to an extracted release's `tools/dhamri/cli.mjs`. Test tokens and sessions stay in a temporary directory. Set `DHAMRI_FFMPEG_TEST=ffmpeg` when running `npm test` to include the real 30/60/120 fps regression check; without FFmpeg that one test is skipped.

Set `DHAMRI_DESKTOP_VIEWER=1` on the native media test to exercise the actual desktop viewer's WHEP player. `tests/desktop-viewer.cjs` uses Playwright and a local synthetic WebRTC source to check approval, mouse/keyboard/scroll, static-screen input, Escape, blur and transport failure with a recording input helper. `tests/control-relay.cjs` starts the actual realtime server with a temporary account store and tests cross-account approval, a session surviving the chat heartbeat, and password-change revocation; install its dependency with `npm ci --prefix server` first. Neither test accesses production accounts.

Go tests normally use a recording input sink. On an interactive Windows desktop, `set DHAMRI_WINDOWS_INPUT_TEST=1` before `go test -v ./cmd/input` additionally creates its own text window, verifies that it has focus, injects one letter and restores the prior focus. This explicitly enabled test exercises real Windows input only in its own window.

`tests/website-control.cjs` runs the real website in isolated Chrome with local synthetic WebRTC media and a recording native input helper. It exercises website sign-in, fresh terminal approval, mouse/keyboard/scroll, chat and player shortcut isolation, stopping control and mobile layout. Set `MAJLIS_PLAYWRIGHT` and optionally `MAJLIS_CHROME` as for the desktop viewer test. It never connects to production accounts or injects input into the real desktop.

References: [FFmpeg WHIP](https://ffmpeg.org/ffmpeg-formats.html#whip), [desktop capture](https://ffmpeg.org/ffmpeg-filters.html#ddagrab), [MediaMTX WebRTC compatibility](https://mediamtx.org/docs/features/webrtc-specific-features), [Pion WebRTC](https://github.com/pion/webrtc), [Tailscale connection types](https://tailscale.com/docs/reference/connection-types).
