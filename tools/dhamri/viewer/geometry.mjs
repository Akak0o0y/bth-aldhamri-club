// Account for both CSS letterboxing and padding inside the encoded frame.
export function sourcePoint(rect, videoWidth, videoHeight, display, clientX, clientY) {
  if (!rect.width || !rect.height || !videoWidth || !videoHeight || !display?.width || !display?.height) return null;
  const outer = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const inner = Math.min(videoWidth / display.width, videoHeight / display.height);
  const width = display.width * inner * outer, height = display.height * inner * outer;
  const left = rect.left + (rect.width - width) / 2, top = rect.top + (rect.height - height) / 2;
  const x = (clientX - left) / width, y = (clientY - top) / height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}
