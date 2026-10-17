import { useEffect, useRef, useState } from 'react';
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
import { checkDevice } from '../stream/deviceCheck';
import { assessQuality } from '../stream/quality';
import {
  goLive,
  PRESETS,
  presetKbps,
  setLiveBitrate,
  setPreviewHidden,
  stopLive,
  stopViewing,
  startViewing,
  streamStore,
} from '../stream/controller';
import { soundFX } from '../services/soundEffects';
import { toast } from '../ui/prefs';
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
    ? 'بث من المتصفح مع قياس الدقة والإطارات الفعلية'
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
  const [presetId, setPresetId] = useState('1440');
  const [fps, setFps] = useState(60);
  const [codec, setCodec] = useState('auto');
  const [override, setOverride] = useState(null); // { key, kbps } — user-dragged bitrate
  const [probeState, setProbeState] = useState(null);
  const [checkProgress, setCheckProgress] = useState(null);
  const [checkResult, setCheckResult] = useState(null);
  const checkRef = useRef(null);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, copy] = useCopy();

  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[1];
  const probeKey = `${preset.id}|${fps}|${override?.key ?? ''}|${override?.kbps ?? ''}`;
  const probes = probeState?.key === probeKey ? probeState.probes : null;
  const autoCodec = probes ? pickAutoCodec(probes) : 'h264';
  const codecId = codec === 'auto' ? autoCodec : codec;
  const autoProbe = probes?.find((p) => p.id === autoCodec);

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

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; checkRef.current?.abort(); };
  }, []);

  // The suggested bitrate follows the picture until the user drags the slider.
  const bitrateKey = `${preset.id}|${codecId}|${fps}`;
  const bitrate = override?.key === bitrateKey ? override.kbps : presetKbps(preset, codecId, fps);
  const audioKbps = source === 'screen' ? 128 : source === 'camera' ? 64 : 0;
  const uploadMbps = ((bitrate + audioKbps) * 1.5) / 1000;
  const checking = checkProgress !== null;
  const selectedProbe = probes?.find((p) => p.id === codecId);
  const checkKey = `${bitrateKey}|${bitrate}`;
  const result = checkResult?.key === checkKey ? checkResult.result : null;

  const runCheck = async () => {
    if (checkRef.current) return;
    const controller = new AbortController();
    checkRef.current = controller;
    setCheckProgress(0);
    setCheckResult(null);
    setError('');
    stopViewing();
    try {
      const result = await checkDevice({ preset, fps, codecId, kbps: bitrate, signal: controller.signal, onProgress: setCheckProgress });
      if (!controller.signal.aborted) setCheckResult({ key: checkKey, result });
    } catch (err) {
      if (!controller.signal.aborted) setError(err.message || 'تعذر إكمال فحص الجهاز');
    } finally {
      if (mounted.current) setCheckProgress(null);
      checkRef.current = null;
      if (streamStore.get().role === 'viewer') startViewing();
    }
  };

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
        <button className="seg__opt" role="tab" aria-selected={tab === 'obs'} onClick={() => setTab('obs')} disabled={checking}>
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
              <p className="hint">
                {contentHint === 'motion'
                  ? 'نفضّل سلاسة الحركة؛ قد تنخفض الدقة أو الإطارات إذا لم يكفِ الجهاز أو الاتصال.'
                  : 'نفضّل التفاصيل؛ قد تنخفض الإطارات عند ضغط الجهاز أو الاتصال.'}
              </p>
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
                  {p.id === '1440' && <span className="preset__badge">جودة عالية</span>}
                  <strong className="num">{p.label}</strong>
                  <span>{p.name}</span>
                  <small className="num">≈ {(presetKbps(p, codecId, fps) / 1000).toFixed(1)} Mbps</small>
                </button>
              ))}
            </div>
            <p className="hint">الهدف {preset.width}×{preset.height} عند {fps} إطار. اختر مصدراً بهذه الدقة؛ فيديو 30 إطار لا يتحول إلى حركة 60 إطار بتكراره.</p>
          </section>

          <section className="studio__block">
            <span className="label">الكودك</span>
            <div className="codecs">
              <button className="codec" aria-pressed={codec === 'auto'} onClick={() => setCodec('auto')}>
                <span className="codec__name">تلقائي</span>
                <span className="codec__note">{probes ? `${autoProbe?.label ?? 'H.264'} — حسب قدرات المتصفح` : 'جارٍ فحص الجودة المحددة…'}</span>
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
            {selectedProbe?.smooth === false && <p className="settings-warn">المتصفح يتوقع صعوبة في هذه الجودة. شغّل فحص الجهاز قبل البث.</p>}
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
              نوصي بسرعة رفع مستقرة ≈ <b className="num">{uploadMbps.toFixed(1)} Mbps</b> مع هامش للاتصال. معدل البت سقف؛ المتصفح يضبط الإرسال حسب المشهد والشبكة.
            </p>
          </section>

          <section className="studio__block">
            <span className="label">فحص الجهاز والألوان</span>
            <p className="hint">فحص محلي لمدة 20 ثانية للترميز وفك الترميز على الجهاز نفسه. أبقِ التبويب ظاهراً. يستخدم لوحة ألوان وحركة تجريبية ولا يختبر سرعة الإنترنت أو أداء اللعبة.</p>
            <button className="btn btn--block" disabled={checking || busy || !probes || selectedProbe?.supported === false} onClick={runCheck}>
              {checking ? <LoaderCircle size={16} className="spin" /> : <Cpu size={16} />}
              {checking ? `جارٍ فحص الجهاز… ${checkProgress}%` : `اختبار ${preset.label} / ${fps} على هذا الجهاز`}
            </button>
            {checking && <button className="link-btn" onClick={() => checkRef.current?.abort()}>إلغاء الفحص</button>}
            {result && (
              <div role="status" className={result.passed ? 'hint' : 'settings-warn'}>
                <strong>{result.passed ? 'حافظ الجهاز على الهدف في الفحص المحلي.' : 'لم نثبت ثبات الهدف في الفحص المحلي.'}</strong>
                <p>أقل إطارات مقاسة: المصدر {result.captureFps ?? '—'} · الإرسال {result.sentFps ?? '—'} · الاستقبال {result.receivedFps ?? '—'} fps.</p>
                <p>الدقة المستقبلة: {result.width ?? '—'}×{result.height ?? '—'} · {result.codec ?? '—'} · {result.hw === true ? 'ترميز بالعتاد' : result.hw === false ? 'ترميز برمجي' : 'نوع المرمّز غير معلن'}.</p>
                <p>متوسط فرق عينات الألوان SDR: {result.colorError ?? '—'} / 255؛ الأقل أقرب للمصدر. هذا فحص عينات وليس معايرة للشاشة أو إثباتاً لألوان HDR.</p>
              </div>
            )}
            <p className="hint">نرسل ألوان المصدر كما يلتقطها المتصفح. إذا ظهرت باهتة، قارن لوحة الألوان من «بث تجريبي». يحتاج HDR إلى توافق الالتقاط والترميز وشاشة المشاهد؛ زيادة التشبع لا تصلح اختلاف النطاق.</p>
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
            <button className="btn btn--primary btn--lg btn--block" onClick={start} disabled={busy || checking || selectedProbe?.supported === false}>
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
        مرجّح بالعتاد
      </span>
    );
  }
  if (hw === false) return <span className="chip codec__hw">قد يستهلك موارد أكثر</span>;
  return null;
}

function LivePanel({ onClose }) {
  const status = useStore(streamStore, (s) => s.status);
  const message = useStore(streamStore, (s) => s.message);
  const publish = useStore(streamStore, (s) => s.publish);
  const stats = useStore(streamStore, (s) => s.stats);
  const previewHidden = useStore(streamStore, (s) => s.previewHidden);
  const config = useStore(streamStore, (s) => s.config);
  const [draft, setDraft] = useState(null);
  const [copied, copy] = useCopy();
  const commitTimer = useRef(0);

  useEffect(() => () => clearTimeout(commitTimer.current), []);

  if (!publish) return null;
  const preset = PRESETS.find((p) => p.id === publish.presetId);
  const kbps = draft ?? publish.requestedKbps;
  const quality = assessQuality(stats, publish);

  const onBitrate = (value) => {
    setDraft(value);
    clearTimeout(commitTimer.current);
    commitTimer.current = setTimeout(async () => {
      await setLiveBitrate(value);
      setDraft((current) => current === value ? null : current);
    }, 350);
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
      <p className={`hint tone-${quality.tone}`} role="status">{quality.text}</p>
      {publish.encodingError && <p className="settings-warn" role="alert">{publish.encodingError}</p>}

      <div className="live-stats">
        <StatsPanel />
      </div>

      <section className="studio__block">
        <div className="studio__row">
          <label className="label" htmlFor="live-bitrate">
            سقف معدل البت المطلوب
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
        <p className="hint">السقف المطبّق: {(publish.kbps / 1000).toFixed(1)} Mbps. ينخفض عند ازدحام مستمر ويعود تدريجياً عند تحسن الشبكة.</p>
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
