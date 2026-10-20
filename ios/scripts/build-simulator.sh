#!/bin/sh
# Builds the app and its broadcast extension for the iOS Simulator (no
# signing needed) and runs the shared core's tests. Needs a Mac with Xcode 15
# or newer and XcodeGen (`brew install xcodegen`).
set -eu
cd "$(dirname "$0")/.."

command -v xcodegen >/dev/null 2>&1 || { echo "Install XcodeGen first: brew install xcodegen" >&2; exit 1; }

xcodegen generate
xcodebuild \
  -project Dhamri.xcodeproj \
  -scheme Dhamri \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO \
  build

swift test --package-path Packages/DhamriCore
