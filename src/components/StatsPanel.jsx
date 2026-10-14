import { Activity, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { streamStore } from '../stream/controller';
import { prefsStore } from '../ui/prefs';

const ms = (v) => (v === null || v === undefined ? null : `${v} ms`);
const mbps = (kbps) => (kbps === null || kbps === undefined ? null : `${(kbps / 1000).toFixed(1)} Mbps`);
const latencyTone = (v) => (v === null ? '' : v < 200 ? 'good' : v < 450 ? 'mid' : 'bad');

const PATHS = {
  host: 'مباشر — نفس الشبكة',
  srflx: 'مباشر عبر الإنترنت',
  prflx: 'مباشر',
  relay: 'عبر سيرفر TURN',
};

const LIMITS = {
  none: ['لا شيء — الأداء ممتاز', 'good'],
  cpu: ['المعالج مضغوط', 'bad'],
  bandwidth: ['سرعة الرفع', 'mid'],
  other: ['أخرى', 'mid'],
};

function viewerRows(s, hwDecode, lowLatency) {
  return [
    ['التأخير التقديري', ms(s.latencyMs), latencyTone(s.latencyMs)],
    ['الدقة', s.width ? `${s.width}×${s.height}` : null],
    ['الإطارات', s.fps !== null && s.fps !== undefined ? `${s.fps} fps` : null],
    ['الكودك', s.codec],
    ['معدل البيانات', mbps(s.kbps)],
    ['ذهاب وعودة (RTT)', ms(s.rttMs)],
    [`المخزن المؤقت · ${lowLatency ? 'لحظي' : 'سلس'}`, ms(s.bufferMs)],
    ['زمن فك الترميز', ms(s.decodeMs)],
    ['فك الترميز', hwDecode === true ? 'بكرت الشاشة' : hwDecode === false ? 'بالمعالج' : null, hwDecode ? 'good' : 'mid'],
    ['فقد الحزم', s.lossPct !== null && s.lossPct !== undefined ? `${s.lossPct}%` : null, s.lossPct > 1 ? 'bad' : ''],
    ['التذبذب (Jitter)', ms(s.jitterMs)],
    ['المسار', s.path ? `${PATHS[s.path] ?? s.path}${s.protocol ? ` · ${s.protocol.toUpperCase()}` : ''}` : null],
    ['إطارات مُسقطة', s.framesDropped],
  ];
}

function hostRows(s) {
  const [limitText, limitTone] = LIMITS[s.limitation] ?? [s.limitation, ''];
  return [
    ['التأخير من جهتك', ms(s.latencyMs), latencyTone(s.latencyMs)],
    ['الدقة المرسلة', s.width ? `${s.width}×${s.height}` : null],
    ['الإطارات', s.fps !== null && s.fps !== undefined ? `${s.fps} fps` : null],
    ['الكودك', s.codec],
    ['المرمّز', s.hw === true ? 'كرت الشاشة' : s.hw === false ? 'المعالج (برمجي)' : s.impl, s.hw ? 'good' : ''],
    ['معدل الرفع', s.kbps !== null ? `${mbps(s.kbps)}${s.targetKbps ? ` / ${mbps(s.targetKbps)}` : ''}` : null],
    ['زمن الترميز', ms(s.encodeMs)],
    ['ذهاب وعودة (RTT)', ms(s.rttMs)],
    ['فقد الحزم', s.lossPct !== null && s.lossPct !== undefined ? `${s.lossPct}%` : null, s.lossPct > 1 ? 'bad' : ''],
    ['عامل التقييد', s.limitation ? limitText : null, limitTone],
  ];
}

export default function StatsPanel({ onClose }) {
  const stats = useStore(streamStore, (s) => s.stats);
  const role = useStore(streamStore, (s) => s.role);
  const hwDecode = useStore(streamStore, (s) => s.hwDecode);
  const lowLatency = useStore(prefsStore, (s) => s.lowLatency);
  const rows = stats ? (role === 'host' ? hostRows(stats) : viewerRows(stats, hwDecode, lowLatency)) : [];

  return (
    <section className="stats-panel" aria-label="إحصائيات البث">
      <header className="stats-panel__head">
        <Activity size={15} />
        <strong>إحصائيات البث</strong>
        <span className="faint">
          <span className="mono">getStats()</span> · كل ثانية
        </span>
        {onClose && (
          <button className="btn btn--ghost btn--icon btn--sm" onClick={onClose} aria-label="إغلاق الإحصائيات">
            <X size={15} />
          </button>
        )}
      </header>
      {stats ? (
        <dl className="stats-panel__grid">
          {rows.map(([label, value, tone]) => (
            <div key={label} className="stats-row">
              <dt>{label}</dt>
              <dd className={`num ${tone ? `tone-${tone}` : ''}`}>{value ?? '—'}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="stats-panel__empty">تظهر الأرقام الحقيقية فور اتصال البث.</p>
      )}
    </section>
  );
}
