import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MousePointer2, ShieldCheck, Square } from 'lucide-react';
import { authStore } from '../auth/session';
import { useStore } from '../lib/store';
import { streamStore } from '../stream/controller';
import { CLOUD_REALTIME_URL, relayUrl } from '../realtime/relay';
import { controlEndpoint, createBrowserControl } from '../control/client';
import { bindRemoteInput } from '../control/input';

const INITIAL = { phase: 'connecting', available: false, busy: false, reason: '', cooldown: false };
const REASONS = {
  stopped: 'انتهى التحكم. يمكنك طلب جلسة جديدة بموافقة المذيع.',
  context: 'توقف التحكم عند مغادرة النافذة أو توقف البث.',
  expired: 'انتهت مهلة الموافقة أو الجلسة. اطلب التحكم من جديد.',
  declined: 'لم يوافق المذيع على الطلب أو انتهت مهلة الموافقة.',
  connection: 'انقطع اتصال التحكم. أعد الاتصال لطلب جلسة جديدة.',
  'request-failed': 'تعذّر قبول الطلب الآن. انتظر قليلاً ثم حاول مجدداً.',
  'untrusted-relay': 'تعذّر الاتصال بخادم التحكم. افتح رابط القناة الأصلي.',
};

export default function RemoteControl({ videoRef, room, stream, enabled, onOpen, onActive }) {
  const token = useStore(authStore, state => state.token);
  const clientRef = useRef(null), enabledRef = useRef(enabled);
  const [state, setState] = useState(INITIAL), [attempt, setAttempt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const relay = relayUrl();
  const endpoint = useMemo(() => {
    try {
      if (!/^[a-z0-9_-]{1,64}$/i.test(room)) return null;
      return controlEndpoint(relay, { pageUrl: location.href, trustedRelay: import.meta.env.VITE_REALTIME_URL || CLOUD_REALTIME_URL });
    } catch { return null; }
  }, [relay, room]);
  const active = state.phase === 'active';
  useLayoutEffect(() => { enabledRef.current = enabled; }, [enabled]);

  useEffect(() => {
    const video = videoRef.current;
    const changed = () => setPlaying(Boolean(video?.videoWidth && !video.paused && !video.ended));
    for (const type of ['playing', 'loadeddata', 'pause', 'emptied', 'ended']) video?.addEventListener(type, changed);
    changed();
    return () => { for (const type of ['playing', 'loadeddata', 'pause', 'emptied', 'ended']) video?.removeEventListener(type, changed); };
  }, [videoRef, stream]);

  useEffect(() => {
    if (!token || !endpoint) return;
    const video = videoRef.current;
    const client = createBrowserControl({ url: endpoint, room, token, onState: setState, canControl: () => {
        const current = streamStore.get();
        return enabledRef.current && current.role === 'viewer' && current.status === 'live' && current.config.room === room &&
          video.srcObject === current.stream && video.videoWidth > 0 && !video.paused && !video.ended &&
          !document.hidden && document.hasFocus() && !document.pictureInPictureElement;
    } });
    clientRef.current = client;
    const unbind = bindRemoteInput(video, client);
    return () => { unbind(); client.close(); clientRef.current = null; };
  }, [token, room, endpoint, attempt, videoRef]);

  useEffect(() => {
    if (!enabled || !playing) clientRef.current?.stop('context');
  }, [enabled, playing, stream]);
  useEffect(() => {
    onActive(active);
    if (active) videoRef.current?.focus({ preventScroll: true });
    return () => onActive(false);
  }, [active, onActive, videoRef]);

  const message = !endpoint ? REASONS['untrusted-relay'] : !token ? 'سجّل الدخول بحسابك لطلب التحكم بلابتوب المذيع.' :
    active ? 'التحكم مفعّل — انقر داخل البث لاستخدام الماوس ولوحة المفاتيح. Esc للإيقاف.' :
    state.phase === 'pending' ? 'بانتظار موافقة المذيع في الطرفية على لابتوبه…' :
    REASONS[state.reason] || (state.phase === 'connecting' ? 'جارٍ الاتصال بخدمة التحكم…' :
      !state.available ? 'المذيع لم يفعّل التحكم على لابتوبه.' :
      state.busy ? 'المذيع يتعامل مع طلب أو جلسة تحكم أخرى.' :
      !enabled || !playing ? 'يُتاح طلب التحكم عند تشغيل البث.' : 'التحكم متاح بعد موافقة المذيع لكل جلسة.');

  return (
    <section className={`remote-control ${active ? 'is-active' : ''}`} aria-label="التحكم بلابتوب المذيع">
      <div className="remote-control__row">
        <div className="remote-control__status" role="status"><ShieldCheck size={18} aria-hidden="true" /><span>{message}</span></div>
        {!token ? <button className="btn btn--sm" disabled={!endpoint} onClick={() => onOpen('account')}>دخول للتحكم</button> :
          active || state.phase === 'pending' ? <button className="btn btn--sm remote-control__stop" onClick={() => clientRef.current?.stop()}><Square size={15} />{active ? 'إيقاف التحكم' : 'إلغاء الطلب'}</button> :
          state.phase === 'closed' ? <button className="btn btn--sm" onClick={() => setAttempt(value => value + 1)}>إعادة اتصال التحكم</button> :
          <button className="btn btn--sm" disabled={!endpoint || !enabled || !playing || state.phase !== 'ready' || !state.available || state.busy || state.cooldown} onClick={() => clientRef.current?.request()}><MousePointer2 size={16} />طلب التحكم</button>}
      </div>
      {!active && <details className="remote-control__help"><summary>كيف أفعّل التحكم؟</summary><p>يشغّل المذيع <code dir="ltr">dhamri start --codec hevc --allow-control</code> من <a href="https://github.com/Akak0o0y/bth-aldhamri-club/releases/tag/native-v0.2.0-rc1" target="_blank" rel="noreferrer">أداة Windows</a> ويوافق على الرمز في الطرفية. أنت تستخدم الموقع فقط. يلزم شاشة واحدة نشطة؛ لشاشة 1080p أضف <code dir="ltr">--size 1920x1080</code>. يستطيع المذيع إيقاف التحكم بـ <kbd>Ctrl+Alt+F10</kbd>.</p></details>}
    </section>
  );
}
