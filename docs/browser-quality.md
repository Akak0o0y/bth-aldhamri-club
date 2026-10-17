# Browser streaming at 1440p60

The target is 2560×1440 at 60 FPS, source-faithful colours and less than one second of source-to-viewer delay, with broadcasting entirely in the browser. The target laptop has 8 GB RAM; its CPU/GPU model and actual performance are still unverified. This implementation requests and measures the target. It cannot certify that laptop from tests on a different computer.

## What changed

| Area | Behavior |
| --- | --- |
| Capture | Requests native 2560×1440 at up to 60 FPS by default. Offers a browser-tab hint in the screen picker. Reports smaller sources instead of claiming they became 1440p. |
| Frame handling | Sends the original captured track straight to WebRTC. Removes the JavaScript worker that repeated frames at 60 Hz. Capture FPS and encoded FPS are separate measurements; neither proves every image is unique. |
| Encoder | Probes the selected dimensions, frame rate and bitrate. Prefers a supported, power-efficient codec predicted to be smooth, starting with H.264. A capability estimate is labelled as an estimate. |
| Quality | Starts 1440p60 H.264 with a 20 Mbps video ceiling. AV1/VP9 have separate starting ceilings; these are engineering defaults, not equivalent-quality guarantees. The UI recommends about 30 Mbps of available upload headroom for the H.264 default. |
| Network | Removes the automatic 6 Mbps cap merely for using TCP. Sustained measured packet queueing/loss lowers the ceiling; sustained healthy measurements gradually restore the chosen ceiling. WebRTC congestion control still determines actual throughput. |
| Resource use | Hides the broadcaster preview by default at 1440p and above for screen/camera input, stops viewer decoding during publishing, and suspends decorative animations while broadcasting. No software upscaling or frame interpolation is added. |
| Viewing | Requests a 100 ms jitter-buffer target when low latency is enabled. This is a receiver hint, not a total-delay guarantee. The browser may choose a different buffer. |
| Controls | Serializes encoder updates, keeps previous settings when an update fails, and ignores completed updates from stopped sessions. Errors remain visible. |
| Measurement | Shows captured and encoded dimensions/FPS, actual bitrate, encoder information when available, queue delay, loss and negotiated transport. Latency estimates cover only that browser's connection to the media server. |

The browser owns screen capture and encoder adaptation. Capture constraints apply after the user selects a surface, and browser downscaling/frame decimation can affect the result. See the [W3C screen-capture specification](https://www.w3.org/TR/screen-capture/). Sender bitrate and frame-rate parameters are limits, not a source generator; see [RTCRtpSender.setParameters](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters). Power-efficiency and smoothness predictions come from [Media Capabilities](https://www.w3.org/TR/media-capabilities/). Receiver behavior is documented under [jitterBufferTarget](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpReceiver/jitterBufferTarget).

## Try it on the target laptop

1. Open **ابدأ البث → من المتصفح**. Keep **2K**, **60** and automatic codec selection. Use the laptop on mains power, with browser graphics acceleration enabled.
2. Run **اختبار 2K / 60 على هذا الجهاز**. Keep the tab visible. It creates a synthetic chart, encodes and decodes it locally for 20 seconds, ignores the first five seconds of warm-up, then reports the lowest sampled source/send/receive FPS. No camera, account, STUN or media server is used by the check itself.
3. Record the actual codec, received dimensions and FPS. A local pass requires all measured dimensions to match, sampled rates of at least 59 FPS, and no reported CPU limitation. A 59 threshold allows normal measurement variation and 59.94 Hz sources; it does not assert exactly 60 new images every second. Missing counters produce an inconclusive result.
4. Test the real screen/tab with moving **1440p60 source material**. A 1080p surface or a 30 FPS video cannot supply native 1440p60 detail and motion. Open the live stats and check both source and encoded dimensions/FPS. Leave the preview hidden to save work.
5. Watch on a second device over the intended network for at least ten minutes with representative motion. Record dimensions/FPS on both ends, packet loss, freezes, actual bitrate, CPU/bandwidth limitation and UDP/TCP path. The short local chart is simpler than a game and also decodes on the publishing laptop, so its load differs from real broadcasting.
6. Measure full delay using **بث تجريبي**, whose chart includes a millisecond clock. View its source and the receiving display together and photograph both in one shot; subtract the visible timestamps. Repeat during motion and network variation. This avoids comparing unsynchronized device clocks. A per-leg WebRTC estimate is insufficient to certify the under-one-second target.

If source FPS is low, investigate the source/capture first. If source FPS is healthy but encoding falls behind with CPU limitation, check the actual encoder and GPU support. If packet queues and losses grow, investigate upload and the server route. A lower resolution is available as an explicit fallback, but does not meet the 1440p60 target.

## Colours

The screen/camera track is not copied through a canvas or artificially saturated. This avoids an extra app-level conversion and keeps the native frames and metadata that the browser provides. The browser still performs capture, colour conversion, encoding and decoding; this is not lossless video or an HDR guarantee.

The synthetic chart contains eight SDR colour patches, shadow/highlight steps and a grayscale ramp. The local check reads only eight patch centres from decoded video and reports mean absolute RGB channel error on a 0–255 scale. It is a diagnostic for that simple SDR chart, not perceptual Delta E, full-frame image quality, display calibration or HDR validation. Compare dark steps, highlights and gradients visually on the source and receiver too. Increased saturation cannot correct a colour-range mismatch.

## Transport and deployment

`src/stream/config.js` defaults to the Gulf media server. `server/gulf/setup.sh` configures UDP 8189 with TCP fallback. The older `server/mediamtx/` Railway setup uses TCP. Do not infer the live transport from a spare configuration: inspect the selected ICE path during a real broadcast. The present work does not change or deploy either server.

Media is encoded once in the browser and forwarded by MediaMTX. Viewer count does not require a new encoder on the publishing laptop, but server bandwidth and each viewer's connection still matter.

## Developer validation

```powershell
npm test
npm run lint
npm run build
```

The Node tests cover capture/quality policy, congestion reduction and recovery, missing telemetry/counter resets, target-specific codec probes, latency units, SDP ceilings, encoder transaction retries, serialized updates, rejection recovery and stopped/restarted publisher sessions.

Browser checks are optional scripts using an existing Playwright installation, without adding a production dependency. Set `MAJLIS_PLAYWRIGHT` to its package directory and `MAJLIS_CHROME` to an installed Chromium/Chrome executable if needed. Start Vite in one terminal:

```powershell
npm run dev -- --host 127.0.0.1 --port 5177 --strictPort
```

Then, from another terminal:

```powershell
# Optional: path to an existing Playwright package and Chrome executable.
# $env:MAJLIS_PLAYWRIGHT = 'C:\path\to\node_modules\playwright'
# $env:MAJLIS_CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
node tests/browser-quality.cjs
node tests/browser-publisher.cjs
```

The quality script exercises the real local encoder/decoder, cancellation, dialog closing, resource cleanup, changed targets, desktop/mobile layout and page errors. The publisher script uses a local in-page WHIP receiver with real WebRTC/SDP, concurrent bitrate changes, simulated rejected parameters, recovery and stopping during an update. Both isolate production HTTP services; the publisher check also disables STUN. Neither requests access to the user's screen nor publishes publicly.

Local validation on 17 October 2026: automated Chromium and installed Chrome completed the 1440p chart check and cleanup without page errors. Their headless runs measured less than 60 FPS and correctly reported that the target was not established. Eight static SDR patches had mean absolute channel error around 0.3/255. These observations do not establish target-laptop performance, game quality, HDR fidelity or Internet end-to-end latency.
