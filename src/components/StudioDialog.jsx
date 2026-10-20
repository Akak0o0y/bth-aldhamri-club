import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Check,
  CircleStop,
  Clock,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  Link2,
  LoaderCircle,
  Mic,
  MicOff,
  Monitor,
  Pause,
  Play,
  Radio,
  Server,
  Smartphone,
  SwitchCamera,
  Users,
  Zap,
} from 'lucide-react';
import { authStore } from '../auth/session';
import { useStore } from '../lib/store';
import { useNow } from '../lib/useNow';
import { rtStore } from '../realtime/channel';
import { perViewerMbps, REFERENCE_SERVER_MBPS, viewerCapacity } from '../stream/capacity';
import { inviteLink, whipUrl } from '../stream/config';
import { checkDevice } from '../stream/deviceCheck';
import { formatElapsed } from '../stream/hold';
import { assessQuality } from '../stream/quality';
import {
  goLive,
  holdLive,
  PRESETS,
  resumeLive,
  setHoldNote,
  setLiveBitrate,
  setMic,
  setPreviewHidden,
  stopLive,
  stopViewing,
  startViewing,
  streamStore,
  switchCamera,
} from '../stream/controller';
import { soundFX } from '../services/soundEffects';
import { toast } from '../ui/prefs';
import Dialog from './Dialog';
import QualityFields from './QualityFields';
import { audioKbpsFor, SOURCES, useQualityDraft } from './qualityDraft';
import StatsPanel from './StatsPanel';
import { StatusPill } from './Status';

export default function StudioDialog({ onClose, onOpen }) {
  const role = useStore(streamStore, (s) => s.role);
  const status = useStore(streamStore, (s) => s.status);
  const held = useStore(streamStore, (s) => Boolean(s.publish?.hold));
  const isHost = role === 'host';
  const subtitle = !isHost
    ? 'بث من المتصفح مع قياس الدقة والإطارات الفعلية'
    : held
      ? 'المشاهدون يرون شاشة الاستراحة — عدّل ما تريد ثم تابع'
      : status === 'live'
        ? 'أنت على الهواء الآن'
        : 'المعاينة تعمل — بانتظار الاتصال بالسيرفر';
  return (
    <Dialog
      title={!isHost ? 'ابدأ البث' : held ? 'البث في استراحة' : 'لوحة البث'}
      subtitle={subtitle}
      icon={held ? Pause : Radio}
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

// A streamer always broadcasts to their own channel (see goLive).
function useWhip() {
  const config = useStore(streamStore, (s) => s.config);
  const myRoom = useStore(authStore, (s) => s.room);
  return whipUrl({ ...config, room: myRoom || config.room });
}

function SetupPanel({ onClose, onOpen }) {
  const config = useStore(streamStore, (s) => s.config);
  const account = useStore(authStore, (s) => s.name);
  const myRoom = useStore(authStore, (s) => s.room);
  const canPublish = Boolean(account || config.publishUser);
  const [tab, setTab] = useState('browser');
  const draft = useQualityDraft();
  const { preset, fps, codecId, bitrate, selectedProbe } = draft;
  const [checkProgress, setCheckProgress] = useState(null);
  const [checkResult, setCheckResult] = useState(null);
  const checkRef = useRef(null);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, copy] = useCopy();
  const whip = useWhip();

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; checkRef.current?.abort(); };
  }, []);

  const checking = checkProgress !== null;
  const checkKey = `${draft.bitrateKey}|${bitrate}`;
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
    const result = await goLive(draft.settings);
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error);
  };

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
        <button className="seg__opt" role="tab" aria-selected={tab === 'phone'} onClick={() => setTab('phone')} disabled={checking}>
          <Smartphone size={16} />
          شاشة الجوال
        </button>
      </div>

      {tab === 'browser' && (
        <div className="studio">
          <QualityFields draft={draft} screenGuide={<PhoneScreenGuide whip={whip} account={account} onCamera={() => draft.setSource('camera')} />} />

          {!draft.blocked && (
            <>
              <section className="studio__block">
                <span className="label">فحص الجهاز والألوان</span>
                <p className="hint">فحص محلي لمدة 20 ثانية للترميز وفك الترميز على الجهاز نفسه. أبقِ التبويب ظاهراً. يستخدم لوحة ألوان وحركة تجريبية ولا يختبر سرعة الإنترنت أو أداء اللعبة.</p>
                <button className="btn btn--block" disabled={checking || busy || !draft.probes || selectedProbe?.supported === false} onClick={runCheck}>
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
            </>
          )}
        </div>
      )}

      {tab === 'obs' && (
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

      {tab === 'phone' && (
        <div className="studio">
          <PhoneScreenGuide whip={whip} account={account} />
        </div>
      )}
    </>
  );
}

// No iPad or iPhone browser can capture the screen (WebKit has no
// getDisplayMedia there). These routes reach the same channel and viewers.
function PhoneScreenGuide({ whip, account, onCamera }) {
  const [copied, copy] = useCopy();
  return (
    <>
      <p className="studio__lead">
        أبل لا تسمح لأي متصفح على <b>الآيباد أو الآيفون</b> بمشاركة الشاشة، وهذا ليس خللاً في الموقع. هذه الطرق تبث شاشة الجهاز إلى قناتك نفسها، ويشاهدها جمهورك هنا كالعادة:
      </p>
      <section className="studio__block">
        <span className="label">١ · من الجهاز نفسه — تطبيق Larix Screencaster</span>
        <ol className="obs-list">
          <li>ثبّت <b>Larix Screencaster</b> من App Store.</li>
          <li>أضف اتصالاً جديداً (<b>Connections</b> ← <b>+</b>) والصق رابط WHIP، وضع الرمز في خانة <b>Token</b> للتوثيق.</li>
        </ol>
        <div className="copy-row">
          <span className="copy-row__key">WHIP URL</span>
          <span className="mono copy-row__val">{whip}</span>
          <button className="btn btn--sm" onClick={() => copy('whip', whip)}>
            {copied === 'whip' ? <Check size={15} /> : <Copy size={15} />}
            {copied === 'whip' ? 'تم' : 'نسخ'}
          </button>
        </div>
        <div className="copy-row">
          <span className="copy-row__key">Token</span>
          <span className="mono copy-row__val">{account || 'اسم-حسابك'}:كلمة-المرور</span>
        </div>
        <ol className="obs-list" start={3}>
          <li>الإعدادات: <code>H.264</code> · <code>1080p</code> أو <code>720p</code> · <code>30 fps</code>. ‏HEVC لا يعمل عند كل المشاهدين.</li>
          <li>افتح <b>مركز التحكم</b>، اضغط مطولاً على زر <b>تسجيل الشاشة</b>، اختر <b>Larix Screencaster</b> ثم <b>بدء البث</b>.</li>
        </ol>
        <p className="hint">النسخة المجانية من Larix تتوقف بعد 5 دقائق؛ الاشتراك يزيل الحد. يصل صوت اللعبة فقط إذا كانت تدعم ReplayKit، وإلا يصل صوت المايك. جرّبه قبل بث مهم.</p>
      </section>
      <section className="studio__block">
        <span className="label">٢ · انعكاس الشاشة (AirPlay) إلى لابتوب</span>
        <ul className="obs-list">
          <li><b>ماك:</b> فعّل <b>AirPlay Receiver</b> من إعدادات النظام، ثم من الآيباد: مركز التحكم ← <b>انعكاس الشاشة</b> ← اختر الماك.</li>
          <li><b>ويندوز:</b> ثبّت مستقبل AirPlay مثل <b>AirServer</b> أو <b>UxPlay</b> ثم اختره من «انعكاس الشاشة».</li>
          <li>من اللابتوب افتح هذا الموقع ← ابدأ البث ← <b>الشاشة أو لعبة</b> ← اختر نافذة الانعكاس، أو استخدم أداة <code>dhamri</code>.</li>
        </ul>
      </section>
      <section className="studio__block">
        <span className="label">٣ · كابل وكرت التقاط — أوضح صورة وأقل تأخير</span>
        <ul className="obs-list">
          <li>وصّل الآيباد بمحول <code>USB-C ← HDMI</code> (أو Lightning ← HDMI للأجهزة الأقدم) ثم بكرت التقاط HDMI في اللابتوب.</li>
          <li>كرت الالتقاط يظهر ككاميرا: اختر <b>الكاميرا والمايك</b> في الموقع على اللابتوب.</li>
        </ul>
      </section>
      <p className="hint">البث إلى التلفزيون (AirPlay أو Chromecast) يعرض الشاشة على التلفزيون فقط، ولا يصل إلى مشاهدي الموقع.</p>
      {onCamera && (
        <button className="btn btn--block" onClick={onCamera}>
          <Camera size={16} />
          ابث بكاميرا هذا الجهاز بدلاً من ذلك
        </button>
      )}
    </>
  );
}

function LivePanel({ onClose }) {
  const status = useStore(streamStore, (s) => s.status);
  const message = useStore(streamStore, (s) => s.message);
  const publish = useStore(streamStore, (s) => s.publish);
  const stats = useStore(streamStore, (s) => s.stats);
  const previewHidden = useStore(streamStore, (s) => s.previewHidden);
  const config = useStore(streamStore, (s) => s.config);
  // Devices in the channel, the streamer's own included.
  const online = useStore(rtStore, (s) => s.online);
  const now = useNow();
  const [draft, setDraft] = useState(null);
  const [copied, copy] = useCopy();
  const commitTimer = useRef(0);

  useEffect(() => () => clearTimeout(commitTimer.current), []);

  if (!publish) return null;
  if (publish.hold) return <HoldPanel onClose={onClose} />;
  const preset = PRESETS.find((p) => p.id === publish.presetId);
  const kbps = draft ?? publish.requestedKbps;
  const quality = assessQuality(stats, publish);
  const watching = Math.max(0, online - 1);
  const audioKbps = audioKbpsFor(publish.source);
  const each = perViewerMbps(publish.kbps, audioKbps);

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
      <div className="live-meta">
        <span className="chip" title="مدة البث">
          <Clock size={13} />
          على الهواء <span className="num">{formatElapsed(now - publish.startedAt)}</span>
        </span>
        <span className="chip" title="الأجهزة المفتوحة على قناتك الآن">
          <Users size={13} />
          <span className="num">{watching}</span> يشاهدون
        </span>
        <span className="chip" title={`كل مشاهد ≈ ${each.toFixed(1)} Mbps من السيرفر`}>
          <Server size={13} />
          السيرفر يرسل ≈ <span className="num">{Math.round(watching * each)}</span> Mbps
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
        <p className="hint">
          بهذا المعدل يخدم سيرفر <span className="num">{REFERENCE_SERVER_MBPS / 1000}</span> Gbps نحو{' '}
          <b className="num">{viewerCapacity(REFERENCE_SERVER_MBPS, publish.kbps, audioKbps)}</b> مشاهد. لتغيير الدقة أو الكودك أو المصدر خذ استراحة وعدّل ثم تابع.
        </p>
      </section>

      <button className="btn btn--lg btn--block" onClick={() => holdLive()}>
        <Pause size={18} />
        استراحة — أوقف البث مؤقتاً وعدّل الإعدادات
      </button>

      <div className="live-actions">
        {publish.hasAudio && (
          <button className="btn" aria-pressed={!publish.micOn} onClick={() => setMic(!publish.micOn)}>
            {publish.micOn ? <MicOff size={16} /> : <Mic size={16} />}
            {publish.micOn ? 'كتم الصوت' : 'تشغيل الصوت'}
          </button>
        )}
        {publish.source === 'camera' && (
          <button className="btn" onClick={() => switchCamera()}>
            <SwitchCamera size={16} />
            {publish.facing === 'environment' ? 'الكاميرا الأمامية' : 'الكاميرا الخلفية'}
          </button>
        )}
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

// While held: viewers see the card; the streamer writes them a note and may
// change any setting before continuing.
function HoldPanel({ onClose }) {
  const publish = useStore(streamStore, (s) => s.publish);
  const account = useStore(authStore, (s) => s.name);
  const now = useNow();
  const whip = useWhip();
  const draft = useQualityDraft({
    source: publish.source,
    presetId: publish.presetId,
    fps: publish.fps,
    codec: publish.codecId,
    contentHint: publish.contentHint,
    facing: publish.facing,
    override: { key: `${publish.presetId}|${publish.codecId}|${publish.fps}`, kbps: publish.requestedKbps },
  });
  const [note, setNote] = useState(publish.hold.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const codecChanged = draft.codecId !== publish.codecId;

  const resume = async () => {
    setBusy(true);
    setError('');
    const result = await resumeLive(draft.settings);
    setBusy(false);
    if (result.ok) {
      soundFX.playRoyalChime();
      onClose();
    } else if (result.error) {
      setError(result.error);
    }
  };

  return (
    <div className="studio">
      <div className="live-head">
        <span className="chip chip--hold">
          <Pause size={13} />
          استراحة · <span className="num">{formatElapsed(now - publish.hold.since)}</span>
        </span>
        <span className="faint">المشاهدون ما زالوا متصلين ويرون شاشة الاستراحة بدون صوت. الكاميرا والمايك مغلقان.</span>
      </div>

      <section className="studio__block">
        <label className="label" htmlFor="hold-note">
          رسالة للمشاهدين
        </label>
        <input
          id="hold-note"
          className="field"
          maxLength={80}
          value={note}
          placeholder="نعود بعد قليل — ابقَ معنا"
          onChange={(e) => {
            setNote(e.target.value);
            setHoldNote(e.target.value);
          }}
        />
        <p className="hint">تظهر على شاشة الاستراحة وعند المشاهدين فوراً.</p>
      </section>

      <QualityFields draft={draft} screenGuide={<PhoneScreenGuide whip={whip} account={account} onCamera={() => draft.setSource('camera')} />} />

      {codecChanged && <p className="settings-warn">تغيير الكودك يفتح اتصالاً جديداً؛ يعود المشاهدون إليه تلقائياً خلال ثوانٍ.</p>}
      {error && (
        <p className="studio__error" role="alert">
          {error}
        </p>
      )}

      <button className="btn btn--primary btn--lg btn--block" onClick={resume} disabled={busy || draft.blocked || draft.selectedProbe?.supported === false}>
        {busy ? <LoaderCircle size={18} className="spin" /> : <Play size={18} />}
        <span>{busy ? 'جارٍ المتابعة…' : 'متابعة البث'}</span>
      </button>
      <button
        className="btn btn--live btn--block"
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
