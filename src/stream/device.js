// What this browser can capture. Every iPad and iPhone browser runs on WebKit
// without getDisplayMedia, so their screen reaches the site only through an
// app (ReplayKit) or another computer; the camera works everywhere.
export function captureSupport(nav = globalThis.navigator) {
  const md = nav?.mediaDevices;
  const ua = nav?.userAgent ?? '';
  return {
    screen: typeof md?.getDisplayMedia === 'function',
    camera: typeof md?.getUserMedia === 'function',
    // iPadOS Safari reports itself as a Mac; touch points tell them apart.
    appleMobile: /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav?.maxTouchPoints > 1),
  };
}
