import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  Coffee,
  EyeOff,
  Flame,
  HandHeart,
  Heart,
  LoaderCircle,
  Maximize,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  Radio,
  Server,
  Settings2,
  Star,
  TriangleAlert,
  Tv,
  Volume2,
  VolumeX,
  WifiOff,
  Zap,
} from 'lucide-react';
import { useStore } from '../lib/store';
import { setLowLatency, setPreviewHidden, streamStore } from '../stream/controller';
import { soundFX } from '../services/soundEffects';
import { emitReaction, prefsStore, reactionsStore, setPref } from '../ui/prefs';
import { BrandMark } from './Brand';
import StatsPanel from './StatsPanel';

const typingTarget = (el) => el?.closest?.('input, textarea, select, [contenteditable="true"], dialog');

// Reaction keys (from the player and the chat) render as small icons.
const REACTION_ICONS = { heart: Heart, fire: Flame, clap: HandHeart, star: Star, coffee: Coffee };

const QUICK_REACTIONS = [
  { key: 'heart', label: 'إعجاب', play: () => soundFX.playChatNotification() },
  { key: 'clap', label: 'تصفيق', play: () => soundFX.playApplause() },
  { key: 'fire', label: 'حماس', play: () => soundFX.playHype() },
];

export default function Player({ onOpen }) {
  const role = useStore(streamStore, (s) => s.role);
  const status = useStore(streamStore, (s) => s.status);
  const message = useStore(streamStore, (s) => s.message);
  const stream = useStore(streamStore, (s) => s.stream);
  const previewHidden = useStore(streamStore, (s) => s.previewHidden);
  const config = useStore(streamStore, (s) => s.config);
  const volume = useStore(prefsStore, (s) => s.volume);
  const muted = useStore(prefsStore, (s) => s.muted);
  const lowLatency = useStore(prefsStore, (s) => s.lowLatency);
  const theater = useStore(prefsStore, (s) => s.theater);

  const rootRef = useRef(null);
  const videoRef = useRef(null);
  const hideTimer = useRef(0);
  const visibleRef = useRef(true);

  const [controls, setControls] = useState(true);
  // Pause belongs to one stream: a new stream always starts playing.
  const [pausedStream, setPausedStream] = useState(null);
  const [showStats, setShowStats] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [blocked, setBlocked] = useState(false);

  const isHost = role === 'host';
  const hasVideo = Boolean(stream) && !(isHost && previewHidden);
  const showVideo = hasVideo && (isHost || status === 'live' || status === 'reconnecting');
  const silent = isHost || muted || blocked || volume === 0;
  const paused = pausedStream !== null && pausedStream === stream;

  // Bind the MediaStream. WebRTC has no buffer to seek, so play() always
  // lands on the live edge.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = hasVideo ? stream : null;
    if (!hasVideo) return;
    const prefs = prefsStore.get();
    video.volume = prefs.volume;
    video.muted = isHost || prefs.muted;
    video.play().catch(() => {
      // Autoplay with sound blocked: start muted and offer one-tap unmute.
      video.muted = true;
      if (!isHost) setBlocked(true);
      video.play().catch(() => {});
    });
  }, [stream, hasVideo, isHost]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = isHost || muted || blocked;
  }, [volume, muted, blocked, isHost]);

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Switching to another app or tab keeps the stream playing in a floating
  // window. Safari: autoPictureInPicture. Chrome: the Media Session
  // 'enterpictureinpicture' action, which the browser fires itself when the
  // page goes to the background (Android Chrome also does it for fullscreen
  // video on its own). The streamer's own preview doesn't need it.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || isHost) return;
    video.autoPictureInPicture = true;
    const session = navigator.mediaSession;
    try {
      session?.setActionHandler('enterpictureinpicture', () => video.requestPictureInPicture().catch(() => {}));
    } catch {
      // This browser has no automatic picture-in-picture.
    }
    return () => {
      video.autoPictureInPicture = false;
      try {
        session?.setActionHandler('enterpictureinpicture', null);
      } catch {
        // Never registered.
      }
    };
  }, [isHost]);

  // Controls auto-hide. setState only fires on hidden<->visible flips, not
  // on every mouse move.
  const poke = useCallback(() => {
    if (!visibleRef.current) {
      visibleRef.current = true;
      setControls(true);
    }
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      visibleRef.current = false;
      setControls(false);
    }, 2800);
  }, []);
  const hold = useCallback(() => clearTimeout(hideTimer.current), []);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const togglePause = useCallback(() => {
    const video = videoRef.current;
    if (!video?.srcObject) return;
    if (video.paused) {
      video.play().catch(() => {});
      setPausedStream(null);
    } else {
      video.pause();
      setPausedStream(video.srcObject);
    }
  }, []);

  const toggleMute = useCallback(() => {
    if (blocked) {
      setBlocked(false);
      setPref({ muted: false });
      return;
    }
    setPref({ muted: !prefsStore.get().muted });
  }, [blocked]);

  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (root?.requestFullscreen) root.requestFullscreen().catch(() => {});
    else videoRef.current?.webkitEnterFullscreen?.();
  }, []);

  const togglePip = useCallback(async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await videoRef.current?.requestPictureInPicture();
    } catch {
      // PiP refused (no frames yet, or unsupported)
    }
  }, []);

  const toggleTheater = useCallback(() => setPref({ theater: !prefsStore.get().theater }), []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typingTarget(e.target)) return;
      // e.code works with the Arabic keyboard layout too.
      const actions = {
        KeyF: toggleFullscreen,
        KeyM: toggleMute,
        KeyT: toggleTheater,
        KeyI: () => setShowStats((v) => !v),
        KeyP: togglePip,
        KeyK: togglePause,
        KeyL: () => setLowLatency(!prefsStore.get().lowLatency),
      };
      const run = actions[e.code];
      if (!run) return;
      e.preventDefault();
      run();
      poke();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [toggleFullscreen, toggleMute, toggleTheater, togglePip, togglePause, poke]);

  const controlsVisible = controls || paused || !showVideo;
  const pipSupported = typeof document !== 'undefined' && document.pictureInPictureEnabled;

  return (
    <div
      ref={rootRef}
      className={`player rise ${controlsVisible ? 'show-ui' : ''} ${showVideo ? 'has-video' : ''}`}
      style={{ '--i': 1 }}
      onPointerMove={poke}
      onPointerDown={(e) => e.pointerType === 'touch' && poke()}
    >
      <div className="player__frame">
        <video
          ref={videoRef}
          className="player__video"
          playsInline
          autoPlay
          disableRemotePlayback
          onDoubleClick={toggleFullscreen}
        />

        {!showVideo && (
          <StageOverlay
            role={role}
            status={status}
            message={message}
            previewHidden={previewHidden}
            server={config.server}
            onOpen={onOpen}
          />
        )}

        {isHost && status !== 'live' && showVideo && (
          <div className="host-banner">
            {status === 'connecting' || status === 'reconnecting' ? <LoaderCircle size={15} className="spin" /> : <WifiOff size={15} />}
            <span>{message || 'جارٍ الاتصال بالسيرفر — هذه معاينة محلية'}</span>
          </div>
        )}

        <Reactions />

        {blocked && showVideo && (
          <button className="unmute" onClick={toggleMute}>
            <VolumeX size={18} />
            <span>اضغط لتشغيل الصوت</span>
          </button>
        )}

        {showStats && <StatsPanel onClose={() => setShowStats(false)} />}

        <div className="player__top">
          <div className="player__title">
            {status === 'live' ? (
              <span className="chip chip--live">
                <span className="dot dot--pulse" />
                {isHost ? 'على الهواء' : 'مباشر'}
              </span>
            ) : (
              <span className="chip chip--accent">
                <span className="dot" />
                {isHost ? 'معاينة' : 'إعادة الاتصال'}
              </span>
            )}
            <span className="player__name">مجلس ظمرة · {config.room}</span>
          </div>
          <div className="quick-react" role="group" aria-label="تفاعل سريع">
            {QUICK_REACTIONS.map(({ key, label, play }) => {
              const Icon = REACTION_ICONS[key];
              return (
                <button
                  key={key}
                  aria-label={label}
                  title={label}
                  onClick={() => {
                    play();
                    emitReaction(key);
                  }}
                >
                  <Icon size={17} />
                </button>
              );
            })}
          </div>
        </div>

        <div className="controls" onPointerEnter={hold} onPointerLeave={poke}>
          <div className="controls__group">
            <Ctl label={paused ? 'تشغيل (K)' : 'إيقاف مؤقت (K)'} onClick={togglePause} disabled={!showVideo}>
              {paused ? <Play size={20} /> : <Pause size={20} />}
            </Ctl>
            {!isHost && (
              <div className="volume">
                <Ctl label={silent ? 'تشغيل الصوت (M)' : 'كتم (M)'} onClick={toggleMute}>
                  {silent ? <VolumeX size={20} /> : <Volume2 size={20} />}
                </Ctl>
                <input
                  type="range"
                  className="range volume__range"
                  min="0"
                  max="1"
                  step="0.02"
                  aria-label="مستوى الصوت"
                  value={muted || blocked ? 0 : volume}
                  style={{ '--pct': `${(muted || blocked ? 0 : volume) * 100}%` }}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setBlocked(false);
                    setPref({ volume: v, muted: v === 0 });
                  }}
                />
              </div>
            )}
          </div>

          <div className="controls__group">
            {!isHost && (
              <button
                className={`latency-toggle ${lowLatency ? 'is-on' : ''}`}
                onClick={() => setLowLatency(!lowLatency)}
                title={lowLatency ? 'لحظي: بدون مخزن مؤقت — أقل تأخير (L)' : 'سلس: مخزن مؤقت صغير للشبكات الضعيفة (L)'}
              >
                <Zap size={15} />
                <span>{lowLatency ? 'لحظي' : 'سلس'}</span>
              </button>
            )}
            <Ctl label="الإحصائيات (I)" active={showStats} onClick={() => setShowStats((v) => !v)}>
              <Activity size={19} />
            </Ctl>
            {pipSupported && (
              <Ctl label="صورة داخل صورة (P)" onClick={togglePip} disabled={!showVideo}>
                <PictureInPicture2 size={19} />
              </Ctl>
            )}
            <Ctl label="وضع المسرح (T)" active={theater} onClick={toggleTheater}>
              <Tv size={19} />
            </Ctl>
            <Ctl label="ملء الشاشة (F)" onClick={toggleFullscreen}>
              {fullscreen ? <Minimize size={19} /> : <Maximize size={19} />}
            </Ctl>
          </div>
        </div>
      </div>
    </div>
  );
}

function Ctl({ label, active, children, ...rest }) {
  return (
    <button className={`ctl ${active ? 'is-active' : ''}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

function Reactions() {
  const items = useStore(reactionsStore, (s) => s.items);
  return (
    <div className="reactions" aria-hidden="true">
      {items.map((r) => {
        const Icon = REACTION_ICONS[r.key] ?? Heart;
        return (
          <span key={r.id} className="reaction" style={{ insetInlineStart: `${r.x}%`, '--drift': `${r.drift}px` }}>
            <Icon size={18} />
          </span>
        );
      })}
    </div>
  );
}

function StageOverlay({ role, status, message, previewHidden, server, onOpen }) {
  if (role === 'host' && previewHidden) {
    return (
      <div className="stage-msg">
        <span className="stage-msg__icon">
          <EyeOff size={22} />
        </span>
        <h3>المعاينة مخفية</h3>
        <p>البث مستمر للمشاهدين، وأخفينا المعاينة لتوفير موارد جهازك.</p>
        <button className="btn btn--sm" onClick={() => setPreviewHidden(false)}>
          إظهار المعاينة
        </button>
      </div>
    );
  }

  if (status === 'offline') {
    return (
      <div className="offair">
        <div className="offair__mark">
          <BrandMark size={72} />
        </div>
        <h3>لا يوجد بث الآن</h3>
        <p>يظهر البث هنا تلقائياً فور بدء المضيف — بدون تحديث الصفحة.</p>
        <button className="btn btn--primary" onClick={() => onOpen('studio')}>
          <Radio size={17} />
          <span>ابدأ البث</span>
        </button>
      </div>
    );
  }

  if (status === 'unreachable') {
    return (
      <div className="stage-msg">
        <span className="stage-msg__icon">
          <WifiOff size={22} />
        </span>
        <h3>سيرفر البث غير متصل</h3>
        <p>
          لم نصل إلى <span className="mono">{server}</span> — سنعيد المحاولة تلقائياً.
        </p>
        <div className="stage-msg__actions">
          <button className="btn btn--sm" onClick={() => onOpen('settings')}>
            <Settings2 size={15} />
            <span>إعداد السيرفر</span>
          </button>
          <button className="btn btn--sm btn--ghost" onClick={() => onOpen('guide')}>
            <Server size={15} />
            <span>طريقة التشغيل</span>
          </button>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="stage-msg">
        <span className="stage-msg__icon stage-msg__icon--warn">
          <TriangleAlert size={22} />
        </span>
        <h3>تعذر تشغيل البث</h3>
        <p>{message}</p>
        <p className="faint">نعيد المحاولة تلقائياً…</p>
      </div>
    );
  }

  return (
    <div className="stage-msg">
      <LoaderCircle size={30} className="spin stage-msg__spinner" />
      <p>{status === 'reconnecting' ? 'جارٍ إعادة الاتصال…' : 'جارٍ الاتصال بالبث…'}</p>
    </div>
  );
}
