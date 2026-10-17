// Starting ceilings, not promised throughput or equivalent quality across codecs.
export const PRESETS = [
  { id: '2160', label: '4K', name: 'Ultra HD', width: 3840, height: 2160, kbps: { h264: 30000, av1: 18000, vp9: 22000, vp8: 30000 } },
  { id: '1440', label: '2K', name: 'QHD', width: 2560, height: 1440, kbps: { h264: 20000, av1: 12000, vp9: 14000, vp8: 24000 } },
  { id: '1080', label: '1080p', name: 'Full HD', width: 1920, height: 1080, kbps: { h264: 10000, av1: 6000, vp9: 7000, vp8: 12000 } },
  { id: '720', label: '720p', name: 'HD', width: 1280, height: 720, kbps: { h264: 5000, av1: 3000, vp9: 3500, vp8: 6000 } },
];

export function presetKbps(preset, codecId, fps) {
  const base = preset.kbps[codecId] ?? preset.kbps.h264;
  return Math.round((fps >= 50 ? base : base * 0.65) / 100) * 100;
}

export function captureOptions(preset, fps) {
  return {
    video: {
      width: { ideal: preset.width, max: preset.width },
      height: { ideal: preset.height, max: preset.height },
      frameRate: { ideal: fps, max: fps },
      displaySurface: 'browser',
    },
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
    systemAudio: 'include',
    surfaceSwitching: 'include',
    selfBrowserSurface: 'exclude',
  };
}

// A current measurement, never a promise that the next frame will arrive.
export function assessQuality(stats, target) {
  const result = (state, text, tone = 'mid') => ({ state, text, tone });
  if (!stats || !target) return result('checking', 'بانتظار قياس جودة البث', '');
  if ([stats.width, stats.height, stats.fps].some((v) => !Number.isFinite(v))) return result('checking', 'جارٍ قياس الإرسال', '');
  if (stats.captureWidth && stats.captureHeight && (stats.captureWidth < target.width || stats.captureHeight < target.height)) {
    return result('capture', 'دقة المصدر أقل من الدقة المطلوبة');
  }
  if (stats.width !== target.width || stats.height !== target.height) return result('resolution', 'الدقة المرسلة لا تطابق الهدف');
  if (stats.limitation === 'cpu') return result('cpu', 'الجهاز لا يحافظ على الجودة المطلوبة', 'bad');
  if (stats.limitation === 'bandwidth') return result('bandwidth', 'الاتصال يقيّد الجودة المطلوبة');
  if (Number.isFinite(stats.captureFps) && stats.captureFps < target.fps - 1) {
    return result('capture', 'إطارات المصدر أقل من الهدف — قد يكون المشهد ثابتاً');
  }
  if (stats.fps < target.fps - 1) return result('framerate', 'الإطارات المرسلة أقل من الهدف');
  if (![stats.captureFps, stats.captureWidth, stats.captureHeight].every(Number.isFinite)) return result('checking', 'الإرسال عند الهدف؛ قياس المصدر غير متاح', '');
  if (stats.limitation !== 'none') return result('checking', 'الإرسال عند الهدف؛ حالة المرمّز غير مؤكدة', '');
  return result('meeting', `${target.height}p / ${target.fps} — القياس الحالي عند الهدف`, 'good');
}
