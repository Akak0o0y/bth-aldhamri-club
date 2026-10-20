// What the studio form edits, shared by "go live" and the hold panel.
import { useEffect, useState } from 'react';
import { Camera, Clapperboard, Monitor } from 'lucide-react';
import { pickAutoCodec, probeEncoders, VIDEO_CODECS } from '../stream/codecs';
import { PRESETS, presetKbps } from '../stream/controller';
import { captureSupport } from '../stream/device';

export const SUPPORT = captureSupport();
// Phones and tablets have a front and a back camera to choose between.
export const HAS_FACING = SUPPORT.appleMobile || !SUPPORT.screen;

export const SOURCES = [
  { id: 'screen', label: 'الشاشة أو لعبة', icon: Monitor },
  { id: 'camera', label: 'الكاميرا والمايك', icon: Camera },
  { id: 'test', label: 'بث تجريبي', icon: Clapperboard },
];

export function audioKbpsFor(source) {
  return source === 'screen' ? 128 : source === 'camera' ? 64 : 0;
}

export function useQualityDraft(initial = {}) {
  // A device without screen capture starts on its camera, at what a phone or
  // tablet camera delivers through the browser.
  const [source, setSource] = useState(initial.source ?? (SUPPORT.screen ? 'screen' : 'camera'));
  const [contentHint, setContentHint] = useState(initial.contentHint ?? 'motion');
  const [presetId, setPresetId] = useState(initial.presetId ?? (SUPPORT.screen ? '1440' : '1080'));
  const [fps, setFps] = useState(initial.fps ?? (SUPPORT.screen ? 60 : 30));
  const [codec, setCodec] = useState(initial.codec ?? 'auto');
  const [facing, setFacing] = useState(initial.facing ?? 'user');
  const [override, setOverride] = useState(initial.override ?? null); // { key, kbps } — user-dragged bitrate
  const [probeState, setProbeState] = useState(null);

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[1];
  const probeKey = `${preset.id}|${fps}|${override?.key ?? ''}|${override?.kbps ?? ''}`;
  const probes = probeState?.key === probeKey ? probeState.probes : null;
  const autoCodec = probes ? pickAutoCodec(probes) : 'h264';
  const codecId = codec === 'auto' ? autoCodec : codec;

  // Probe the selected workload, including codec-specific bitrate. No CPU-count
  // guess and no stale 1080p result shown beside a 1440p/4K selection.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      const codecKbps = Object.fromEntries(VIDEO_CODECS.map((c) => [c.id,
        override?.key === `${preset.id}|${c.id}|${fps}` ? override.kbps : presetKbps(preset, c.id, fps),
      ]));
      probeEncoders({ width: preset.width, height: preset.height, fps, codecKbps }).then((p) => {
        if (!cancelled) setProbeState({ key: probeKey, probes: p });
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [preset, fps, override, probeKey]);

  // The suggested bitrate follows the picture until the user drags the slider.
  const bitrateKey = `${preset.id}|${codecId}|${fps}`;
  const bitrate = override?.key === bitrateKey ? override.kbps : presetKbps(preset, codecId, fps);
  const finalHint = source === 'screen' ? contentHint : 'motion';

  return {
    source, setSource, contentHint, setContentHint, preset, setPresetId, fps, setFps,
    codec, setCodec, codecId, autoCodec, facing, setFacing, probes, bitrate, bitrateKey,
    setBitrate: (kbps) => setOverride({ key: bitrateKey, kbps }),
    selectedProbe: probes?.find((p) => p.id === codecId),
    // iPad and iPhone browsers cannot capture the screen at all.
    blocked: source === 'screen' && !SUPPORT.screen,
    settings: { source, preset, fps, codecId, contentHint: finalHint, kbps: bitrate, facing },
  };
}
