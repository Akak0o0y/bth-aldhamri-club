# iPhone / iPad broadcaster (ReplayKit → WHIP)

iPad and iPhone browsers have no screen capture (`getDisplayMedia`), so until
now an iOS streamer needed Larix Screencaster. `ios/` is our own small app
instead: its Broadcast Upload Extension sends the whole screen, app audio and
the microphone to MediaMTX over WebRTC, exactly like the browser studio.

> **Status:** scaffolded on Windows. The shared logic in
> `ios/Packages/DhamriCore` has unit tests whose SDP expectations come from
> running `src/stream/sdp.js`. Nothing has been compiled yet: the first build
> on a Mac or in CI may need small API-name fixes, and streaming from a real
> device has **not** been tested. See [Not verified yet](#not-verified-yet).

## How it works

- **App** (`ios/App`): sign in with the site's streamer account
  (`POST /api/login` on the realtime relay, as the site's account dialog does).
  The session is stored in the Keychain under the App Group so the extension
  can read it. The app shows the channel, watch link and WHIP URL, lets you pick
  720p/1080p and "sharp" vs "smooth", and has a start button (the system
  broadcast picker). It refreshes the session with `/api/me` and signs out
  when the relay refuses it.
- **Extension** (`ios/Broadcast`), per broadcast:
  - **Video:** each ReplayKit frame is scaled into the preset and turned
    upright by VideoToolbox. It's then encoded as H.264 by libwebrtc's hardware
    (VideoToolbox) encoder at a constant 30 fps; the last frame repeats while
    the screen is still.
  - **Audio:** app audio and the microphone are converted to 48 kHz mono,
    mixed, and sent as 96 kbps Opus.
  - **WHIP:** OPTIONS for ICE servers, then POST the offer to
    `<server>/<room>/whip?session=<8 random chars>` with
    `Authorization: Bearer <token>`. Late candidates go as PATCH trickle-ICE,
    and a DELETE is sent on stop. The SDP edits match the studio's
    (`tunePublisherOffer`/`tunePublisherAnswer`). Reconnects reuse the same
    `session`, so the channel's chat is only cleared when a new broadcast
    starts. A 401/403 signs the device out and ends the broadcast with a
    message.
  - **Hold:** while ReplayKit has the broadcast paused, the extension joins the
    channel's relay room and sends `{t:'hold', on:true, elapsed, note:'', token}`.
    Resuming sends `{on:false}`, and stopping mid-hold sends `ended:true`. This
    needs a relay with the hold handler (`hold` in `server/realtime.js`); older
    relays ignore it and viewers just keep the last frame.

## Why Google's WebRTC (`stasel/WebRTC`)

| Option | For | Against |
| --- | --- | --- |
| **libwebrtc** via [stasel/WebRTC](https://github.com/stasel/WebRTC) (chosen) | The engine Safari and Chrome already use to publish to this MediaMTX. Has congestion control, NACK/RTX and pacing (needed on mobile networks), a built-in VideoToolbox H.264 encoder and Opus, and ICE over UDP and TCP (MediaMTX's TCP 8189 fallback). Prebuilt xcframework with simulator slices. `RTCAudioDevice` lets us feed it ReplayKit audio. | Large binary; memory must be watched. |
| libdatachannel (what OBS's WHIP output uses) | Small. | Needs our own iOS cross-builds of it, OpenSSL/mbedTLS, libsrtp and libopus. RTP/RTCP glue written by hand, and no bandwidth estimation, so quality won't adapt on cellular. |
| HaishinKit `RTCHaishinKit` | Swift, built with ReplayKit in mind. | Its WebRTC/WHIP module is alpha, and its documented ReplayKit path is RTMP. Worth re-checking later. |

**Memory.** A broadcast extension is killed above ~50 MB. That limit counts
dirty memory; the framework's code is mapped from disk, so its size mostly
doesn't count. What does count is frame buffers and codec state, so:

- frames are scaled into our own pool before WebRTC sees them (at most 6
  buffers; a 1080p NV12 frame is about 3 MB);
- only the H.264 encoder factory is registered;
- nothing is decoded;
- audio processing (echo cancelling, noise suppression, gain control) is off.

Profile on a device and aim to stay under ~35 MB.

## Requirements

- A **Mac with Xcode 15 or newer** (Windows can't build or sign iOS apps), plus
  [XcodeGen](https://github.com/yonaskolb/XcodeGen): `brew install xcodegen`.
- An iPhone or iPad on **iOS 16 or newer**.
- An **Apple ID** for signing:
  - **Free (Personal Team):** installs only on your own devices, and the app
    **stops opening after 7 days** until you run it from Xcode again. You need
    your own bundle id and App Group id. If Xcode refuses the App Groups
    capability for your team, a paid account is needed.
  - **Apple Developer Program** (paid, yearly): one-year profiles,
    **TestFlight** for other streamers, and the App Store.

## Build for the simulator

```bash
sh ios/scripts/build-simulator.sh
```

It generates `ios/Dhamri.xcodeproj` and builds the app and extension for the
iOS Simulator without signing (`xcodebuild … CODE_SIGNING_ALLOWED=NO`), then
runs `swift test` for `DhamriCore`. `.github/workflows/ios.yml` runs the same
on GitHub's macOS runner whenever `ios/` changes. The core tests also run on
Linux. The Simulator can build the extension but can't run a system broadcast;
that needs a real device.

## Install on a device

1. In `ios/project.yml`, set `DHAMRI_BUNDLE_ID` to your own id (for example
   `com.yourname.dhamri`). The extension (`….broadcast`) and App Group
   (`group.…`) follow it.
2. Run `cd ios && xcodegen generate && open Dhamri.xcodeproj`.
3. In **Signing & Capabilities**, choose your Team for both **Dhamri** and
   **DhamriBroadcast**. Check that App Groups shows `group.<your id>` on both.
4. Plug in the device (or pair it over Wi-Fi), select it, and press **Run**.
   First time only:
   - turn on **Developer Mode** (Settings → Privacy & Security);
   - with a free account, trust yourself under Settings → General →
     VPN & Device Management.
5. Open **بث الضمري** and sign in with your streamer account (the same one as
   on the site).

**For TestFlight (paid account):** Product → Archive → Distribute App → App
Store Connect. Before uploading, check that the archive has no
`PlugIns/DhamriBroadcast.appex/Frameworks` folder: the App Store rejects
frameworks inside extensions, and `project.yml` embeds WebRTC in the app only.

## Start a broadcast

- **From the app:** tap **ابدأ البث أو أوقفه**. The system sheet opens with
  **بث الضمري** selected. Turn the microphone on or off, then tap
  **Start Broadcast**. After the 3-second countdown, switch to the game or app.
- **From Control Center:** add **Screen Recording** in Settings → Control
  Center if it's missing. Open Control Center, long-press the record button,
  pick **بث الضمري**, set the microphone, then tap **Start Broadcast**.
- **Stop** from the red recording indicator in the status bar or Dynamic
  Island, or from the same Control Center button.
- **Viewers** open the watch link the app shows
  (`https://dhamri.vercel.app/?room=<channel>`).

## Limits

- **Video:** 30 fps at most, up to 1080p (720p preset available).
  Protected/DRM video shows black, as with any iOS screen recording.
- **Audio:** mono. libwebrtc's iOS audio module reads delivered buffers as
  one channel.
- **Session:** the relay's tokens last 30 days; after that, sign in again in
  the app.
- **One channel:** a streamer always broadcasts to their own channel.

## Not verified yet

Written without a Mac, so first:

- [ ] `sh ios/scripts/build-simulator.sh` passes. Likely fix points: the
      Swift names of `RTCAudioDevice` methods and of
      `VTPixelRotationSession*` in Xcode's SDK.
- [ ] A device broadcast reaches viewers, with app audio and mic mixed.
- [ ] Landscape left and right both arrive upright. The orientation mapping
      is in `ScreenRotation(orientation:)`; flip `.cw90`/`.cw270` there if
      they come out upside down.
- [ ] Memory stays well under 50 MB at 1080p on the oldest supported iPad
      (Xcode's memory gauge while broadcasting).
- [ ] Stop makes viewers' player go offline at once (the DELETE gets out).
- [ ] Reconnects after switching Wi-Fi ↔ cellular.
- [ ] The hold card shows when ReplayKit pauses (on a relay with the hold
      handler).
