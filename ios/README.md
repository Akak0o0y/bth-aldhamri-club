# بث الضمري for iPhone and iPad

A small native app whose ReplayKit Broadcast Upload Extension shares the
device's screen, app audio and microphone to the site over WebRTC (WHIP), the
same way the browser studio does. iPad and iPhone streamers then no longer need
Larix Screencaster.

Setup, build, install and limits: [docs/ios-broadcaster.md](../docs/ios-broadcaster.md).

```
ios/
├── project.yml            XcodeGen spec: app + extension, WebRTC package
├── App/                   SwiftUI host app: sign in, quality, start button
├── Broadcast/             Broadcast Upload Extension: ReplayKit → WebRTC → WHIP
├── Shared/                Keychain session and App Group settings (both targets)
├── Packages/DhamriCore/   Foundation-only logic + tests (`swift test`)
└── scripts/build-simulator.sh
```
