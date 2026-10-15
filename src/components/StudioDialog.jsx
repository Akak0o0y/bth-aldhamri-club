import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Check,
  CircleStop,
  Clapperboard,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  FileText,
  Gamepad2,
  Link2,
  LoaderCircle,
  Monitor,
  Radio,
  Zap,
} from 'lucide-react';
import { authStore } from '../auth/session';
import { useStore } from '../lib/store';
import { pickAutoCodec, probeEncoders, VIDEO_CODECS } from '../stream/codecs';
import { inviteLink, whipUrl } from '../stream/config';
import {
  goLive,
  PRESETS,
  presetKbps,
  setLiveBitrate,
  setPreviewHidden,
  stopLive,
  streamStore,
} from '../stream/controller';
import { soundFX } from '../services/soundEffects';
import { LOW_END, toast } from '../ui/prefs';
import Dialog from './Dialog';
import StatsPanel from './StatsPanel';
import { StatusPill } from './Status';

const SOURCES = [
  { id: 'screen', label: 'الشاشة أو لعبة', icon: Monitor },
  { id: 'camera', label: 'الكاميرا والمايك', icon: Camera },
  { id: 'test', label: 'بث تجريبي', icon: Clapperboard },
];

export default function StudioDialog({ onClose, onOpen }) {
  const role = useStore(streamStore, (s) => s.role);
  const status = useStore(streamStore, (s) => s.status);
  const isHost = role === 'host';
  const subtitle = !isHost
    ? 'ترميز واحد بكرت الشاشة — ويصل للجميع بأقل تأخير'
    : status === 'live'
      ? 'أنت على الهواء الآن'
      : 'المعاينة تعمل — بانتظار الاتصال بالسيرفر';
  return (
    <Dialog
      title={isHost ? 'لوحة البث' : 'ابدأ البث'}
      subtitle={subtitle}
      icon={Radio}
      size="lg"
      onClose={onClose}
    >
      {isHost ? <LivePanel onClose={onClose} /> : <SetupPanel onClose={onClose} onOpen={onOpen} />}
    </Dialog>
  );
}

function useCopy() {
  const [copied, setCopied] = useState('');
  const copy = async (key, text) => {
    try {
      await navigator.clipboard.writeText(text);
      soundFX.playChatNotification();
      setCopied(key);
      setTimeout(() => setCopied(''), 1800);
    } catch {
      toast('تعذر النسخ', 'warn');
    }
  };
  return [copied, copy];
}

function SetupPanel({ onClose, onOpen }) {
  const config = useStore(streamStore, (s) => s.config);
  const account = useStore(authStore, (s) => s.name);
  const myRoom = useStore(authStore, (s) => s.room);
  const canPublish = Boolean(account || config.publishUser);
  const [tab, setTab] = useState('browser');
  const [source, setSource] = useState('screen');
  const [contentHint, setContentHint] = useState('motion');
  const [presetId, setPresetId] = useState(null);
  const [fps, setFps] = useState(LOW_END ? 30 : 60);
  const [codec, setCodec] = useState('auto');
  const [override, setOverride] = useState(null); // { key, kbps } — user-dragged bitrate
  const [probes, setProbes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, copy] = useCopy();

  const autoCodec = probes ? pickAutoCodec(probes) : 'h264';
  const codecId = codec === 'auto' ? autoCodec : codec;
  const autoProbe = probes?.find((p) => p.id === autoCodec);

  // What this machine can carry comfortably.
  const recommended = useMemo(() => {
    if (!probes) return '1080';
    if (!autoProbe?.hw) return '720';
    return (navigator.hardwareConcurrency || 4) >= 8 && !LOW_END ? '1440' : '1080';
  }, [probes, autoProbe]);

  const preset = PRESETS.find((p) => p.id === (presetId ?? recommended)) ?? PRESETS[2];

  // One hardware probe per dialog open, at a fixed 1080p60 target.
  useEffect(() => {
    let cancelled = false;
    probeEncoders({ width: 1920, height: 1080, fps: 60, kbps: 7000 }).then((p) => {
      if (!cancelled) setProbes(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The suggested bitrate follows the picture until the user drags the slider.
  const bitrateKey = `${preset.id}|${codecId}|${fps}`;
  const bitrate = override?.key === bitrateKey ? override.kbps : presetKbps(preset, codecId, fps);
  const audioKbps = source === 'screen' ? 128 : source === 'camera' ? 64 : 0;
  const uploadMbps = ((bitrate + audioKbps) * 1.08) / 1000;

  const start = async () => {
    // Only streamers with an account may publish; send everyone else to log in.
    if (!canPublish) return onOpen('account');
    setBusy(true);
    setError('');
    soundFX.playRoyalChime();
    const result = await goLive({
      source,
      preset,
      fps,
      codecId,
      contentHint: source === 'screen' ? contentHint : 'motion',
      kbps: bitrate,
    });
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error);
  };

  // A streamer always broadcasts to their own channel (see goLive).
  const whip = whipUrl({ ...config, room: myRoom || config.room });

  return (
    <>
      <div className="seg studio__tabs" role="tablist">
        <button className="seg__opt" role="tab" aria-selected={tab === 'browser'} onClick={() => setTab('browser')}>
          <Monitor size={16} />
          من المتصفح
        </button>
        <button className="seg__opt" role="tab" aria-selected={tab === 'obs'} onClick={() => setTab('obs')}>
          <Zap size={16} />
          OBS Studio
        </button>
      </div>

      {tab === 'browser' ? (
        <div className="studio">
          <section className="studio__block">
            <span className="label">المصدر</span>
            <div className="seg seg--wrap">
              {SOURCES.map(({ id, label, icon: Icon }) => (
                <button key={id} className="seg__opt" aria-pressed={source === id} onClick={() => setSource(id)}>
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
          </section>

          {source === 'screen' && (
            <section className="studio__block">
              <span className="label">نوع المحتوى</span>
              <div className="seg">
                <button className="seg__opt" aria-pressed={contentHint === 'motion'} onClick={() => setContentHint('motion')}>
                  <Gamepad2 size={16} />
                  ألعاب وأفلام — سلاسة الحركة
                </button>
                <button className="seg__opt" aria-pressed={contentHint === 'detail'} onClick={() => setContentHint('detail')}>
                  <FileText size={16} />
                  شاشة ونصوص — حدة التفاصيل
                </button>
              </div>
            </section>
          )}

          <section className="studio__block">
            <div className="studio__row">
              <span className="label">الدقة</span>
              <div className="seg seg--compact" aria-label="معدل الإطارات">
                {[60, 30].map((f) => (
                  <button key={f} className="seg__opt" aria-pressed={fps === f} onClick={() => setFps(f)}>
                    <span className="num">{f}</span> إطار
                  </button>
                ))}
              </div>
            </div>
            <div className="presets">
              {PRESETS.map((p) => (
                <button key={p.id} className="preset" aria-pressed={preset.id === p.id} onClick={() => setPresetId(p.id)}>
                  {recommended === p.id && <span className="preset__badge">مناسب لجهازك</span>}
                  <strong className="num">{p.label}</strong>
                  <span>{p.name}</span>
                  <small className="num">≈ {(presetKbps(p, codecId, fps) / 1000).toFixed(1)} Mbps</small>
                </button>
              ))}
            </div>
            {fps === 30 && <p className="hint">30 إطار تقلل حمل الترميز للنصف — مثالية للأجهزة المحدودة.</p>}
          </section>

          <section className="studio__block">
            <span className="label">الكودك</span>
            <div className="codecs">
              <button className="codec" aria-pressed={codec === 'auto'} onClick={() => setCodec('auto')}>
                <span className="codec__name">تلقائي</span>
                <span className="codec__note">{probes ? `${autoProbe?.label ?? 'H.264'} — الأنسب لجهازك وللمشاهدين` : 'جارٍ فحص كرت الشاشة…'}</span>
                {probes ? <HwBadge hw={autoProbe?.hw} /> : <LoaderCircle size={14} className="spin" />}
              </button>
              {(probes ?? VIDEO_CODECS).map((c) => (
                <button
                  key={c.id}
                  className="codec"
                  aria-pressed={codec === c.id}
                  disabled={probes ? !c.supported : false}
                  onClick={() => setCodec(c.id)}
                >
                  <span className="codec__name num">{c.label}</span>
                  <span className="codec__note">{c.supported === false ? 'غير مدعوم في هذا المتصفح' : c.note}</span>
                  {probes && c.supported && <HwBadge hw={c.hw} />}
                </button>
              ))}
            </div>
          </section>

          <section className="studio__block">
            <div className="studio__row">
              <label className="label" htmlFor="studio-bitrate">
                معدل البت
              </label>
              <span className="chip chip--accent num">{(bitrate / 1000).toFixed(1)} Mbps</span>
            </div>
            <input
              id="studio-bitrate"
              type="range"
              className="range"
              min="1000"
              max="30000"
              step="500"
              value={bitrate}
              style={{ '--pct': `${((bitrate - 1000) / 29000) * 100}%` }}
              onChange={(e) => setOverride({ key: bitrateKey, kbps: Number(e.target.value) })}
            />
            <p className="hint">
              تحتاج سرعة رفع ≈ <b className="num">{uploadMbps.toFixed(1)} Mbps</b> — ويبقى نفس الحمل مهما زاد عدد المشاهدين.
            </p>
          </section>

          <footer className="studio__foot">
            <div className="studio__target">
              <span className="faint">يرسل إلى</span>
              <span className="mono">{whip}</span>
              <button className="link-btn" onClick={() => onOpen('settings')}>
                تغيير
              </button>
            </div>
            {canPublish ? (
              account && (
                <p className="hint">
                  تبث باسم {account} في قناتك <span className="mono">{myRoom}</span>
                </p>
              )
            ) : (
              <p className="settings-warn">
                البث لأصحاب الحسابات.{' '}
                <button className="link-btn" onClick={() => onOpen('account')}>
                  سجّل الدخول
                </button>{' '}
                أو اطلب رابط دعوة من مذيع.
              </p>
            )}
            {error && (
              <p className="studio__error" role="alert">
                {error}
              </p>
            )}
            <button className="btn btn--primary btn--lg btn--block" onClick={start} disabled={busy}>
              {busy ? <LoaderCircle size={18} className="spin" /> : <Radio size={18} />}
              <span>{busy ? 'جارٍ التجهيز…' : 'ابدأ البث الآن'}</span>
            </button>
          </footer>
        </div>
      ) : (
        <div className="studio">
          <p className="studio__lead">
            OBS 30 وأحدث يبث بـ <b>WHIP</b> مباشرة: ترميز بكرت الشاشة (NVENC / AMF / QuickSync) وتأخير أقل من نصف ثانية.
          </p>
          <section className="studio__block">
            <span className="label">Settings ← Stream</span>
            <div className="copy-row">
              <span className="copy-row__key">Service</span>
              <span className="mono">WHIP</span>
            </div>
            <div className="copy-row">
              <span className="copy-row__key">Server</span>
              <span className="mono copy-row__val">{whip}</span>
              <button className="btn btn--sm" onClick={() => copy('whip', whip)}>
                {copied === 'whip' ? <Check size={15} /> : <Copy size={15} />}
                {copied === 'whip' ? 'تم' : 'نسخ'}
              </button>
            </div>
            <div className="copy-row">
              <span className="copy-row__key">Bearer Token</span>
              {/* The relay accepts "name:password" from OBS (see mtxAuth). */}
              <span className="mono copy-row__val">{account || 'اسم-حسابك'}:كلمة-المرور</span>
            </div>
          </section>
          <section className="studio__block">
            <span className="label">Settings ← Output — لأعلى دقة وأقل تأخير</span>
            <ul className="obs-list">
              <li>
                <b>Encoder:</b> <code>NVIDIA NVENC H.264</code> (أو AV1 إذا كان كرت المشاهدين حديثاً)
              </li>
              <li>
                <b>Rate Control:</b> <code>CBR</code> · <b>Bitrate:</b> <code>6000–12000 Kbps</code> لـ 1080p/1440p
              </li>
              <li>
                <b>Keyframe Interval:</b> <code>1 s</code> — دخول أسرع للمشاهدين الجدد
              </li>
              <li>
                <b>Preset:</b> <code>P4</code> · <b>Tuning:</b> <code>Ultra Low Latency</code>
              </li>
              <li>
                <b>Max B-frames:</b> <code>0</code> — ‏WebRTC لا يدعمها
              </li>
              <li>
                <b>Look-ahead</b> و <b>Psycho Visual Tuning:</b> إيقاف
              </li>
              <li>
                <b>Advanced ← Video:</b> <code>NV12</code> · <code>Rec. 709</code> · <b>Color Range:</b> <code>Limited</code> — نفس ألوان
                مصدرك عند المشاهدين بدون باهت
              </li>
            </ul>
          </section>
        </div>
      )}
    </>
  );
}

function HwBadge({ hw }) {
  if (hw === true) {
    return (
      <span className="chip chip--good codec__hw">
        <Cpu size={12} />
        كرت الشاشة
      </span>
    );
  }
  if (hw === false) return <span className="chip codec__hw">برمجي</span>;
  return null;
}

function LivePanel({ onClose }) {
  const status = useStore(streamStore, (s) => s.status);
  const message = useStore(streamStore, (s) => s.message);
  const publish = useStore(streamStore, (s) => s.publish);
  const previewHidden = useStore(streamStore, (s) => s.previewHidden);
  const config = useStore(streamStore, (s) => s.config);
  const [kbps, setKbps] = useState(publish?.kbps ?? 6000);
  const [copied, copy] = useCopy();
  const commitTimer = useRef(0);

  useEffect(() => () => clearTimeout(commitTimer.current), []);

  if (!publish) return null;
  const preset = PRESETS.find((p) => p.id === publish.presetId);

  const onBitrate = (value) => {
    setKbps(value);
    clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(() => setLiveBitrate(value), 350);
  };

  return (
    <div className="studio">
      <div className="live-head">
        <StatusPill role="host" status={status} />
        <span className="faint">
          {SOURCES.find((s) => s.id === publish.source)?.label} · <span className="num">{preset?.label}</span> ·{' '}
          <span className="num">{publish.fps}</span> إطار · {publish.codecLabel}
        </span>
      </div>
      {message && status !== 'live' && <p className="studio__error">{message}</p>}

      <div className="live-stats">
        <StatsPanel />
      </div>

      <section className="studio__block">
        <div className="studio__row">
          <label className="label" htmlFor="live-bitrate">
            معدل البت أثناء البث
          </label>
          <span className="chip chip--accent num">{(kbps / 1000).toFixed(1)} Mbps</span>
        </div>
        <input
          id="live-bitrate"
          type="range"
          className="range"
          min="1000"
          max="30000"
          step="500"
          value={kbps}
          style={{ '--pct': `${((kbps - 1000) / 29000) * 100}%` }}
          onChange={(e) => onBitrate(Number(e.target.value))}
        />
      </section>

      <div className="live-actions">
        <button className="btn" onClick={() => setPreviewHidden(!previewHidden)}>
          {previewHidden ? <Eye size={16} /> : <EyeOff size={16} />}
          {previewHidden ? 'إظهار المعاينة' : 'إخفاء المعاينة لتوفير الموارد'}
        </button>
        <button className="btn" onClick={() => copy('invite', inviteLink(config))}>
          {copied === 'invite' ? <Check size={16} /> : <Link2 size={16} />}
          {copied === 'invite' ? 'تم نسخ الرابط' : 'رابط الدعوة'}
        </button>
      </div>

      <button
        className="btn btn--live btn--lg btn--block"
        onClick={() => {
          stopLive();
          onClose();
        }}
      >
        <CircleStop size={18} />
        إنهاء البث
      </button>
    </div>
  );
}
