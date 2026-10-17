import { Activity, X } from 'lucide-react';
import { useStore } from '../lib/store';
import { streamStore } from '../stream/controller';
import { prefsStore } from '../ui/prefs';

const ms = (v) => (v === null || v === undefined ? null : `${v} ms`);
const mbps = (kbps) => (kbps === null || kbps === undefined ? null : `${(kbps / 1000).toFixed(1)} Mbps`);
const latencyTone = (v) => (v === null ? '' : v < 200 ? 'good' : v < 450 ? 'mid' : 'bad');

const PATHS = {
  host: 'مباشر إلى الطرف المقابل',
  srflx: 'مباشر عبر الإنترنت',
  prflx: 'مباشر',
  relay: 'عبر سيرفر TURN',
};

const LIMITS = {
  none: ['لا يوجد تقييد مُبلّغ', 'good'],
  cpu: ['المعالج مضغوط', 'bad'],
  bandwidth: ['سرعة الرفع', 'mid'],
  other: ['أخرى', 'mid'],
};

function viewerRows(s, hwDecode, lowLatency) {
  return [
    ['من السيرفر إليك (تقديري)', ms(s.latencyMs), latencyTone(s.latencyMs)],
    ['الدقة', s.width ? `${s.width}×${s.height}` : null],
    ['الإطارات', s.fps !== null && s.fps !== undefined ? `${s.fps} fps` : null],
    ['الكودك', s.codec],
    ['معدل البيانات', mbps(s.kbps)],
    ['ذهاب وعودة (RTT)', ms(s.rttMs)],
    [`المخزن المؤقت · ${lowLatency ? 'هدف 100 ms' : 'تلقائي'}`, ms(s.bufferMs)],
    ['زمن فك الترميز', ms(s.decodeMs)],
    ['فك الترميز', s.hw === true ? 'بالعتاد' : s.hw === false ? 'برمجي' : hwDecode === true ? 'مرجّح بالعتاد' : hwDecode === false ? 'قد يستهلك موارد أكثر' : s.impl, hwDecode ? 'good' : 'mid'],
    ['فقد الحزم', s.lossPct !== null && s.lossPct !== undefined ? `${s.lossPct}%` : null, s.lossPct > 1 ? 'bad' : ''],
    ['التذبذب (Jitter)', ms(s.jitterMs)],
    ['المسار', s.path ? `${PATHS[s.path] ?? s.path}${s.protocol ? ` · ${s.protocol.toUpperCase()}` : ''}` : null],
    ['إطارات مُسقطة', s.framesDropped],
    ['مرات التجمد', s.freezes],
  ];
}

function hostRows(s) {
  const [limitText, limitTone] = LIMITS[s.limitation] ?? [s.limitation, ''];
  return [
    ['إلى السيرفر (تقديري)', ms(s.latencyMs), latencyTone(s.latencyMs)],
    ['دقة المصدر', s.captureWidth ? `${s.captureWidth}×${s.captureHeight}` : null],
    ['إطارات المصدر', s.captureFps == null ? null : `${s.captureFps} fps`],
    ['الدقة المرسلة', s.width ? `${s.width}×${s.height}` : null],
    ['الإطارات المرمّزة', s.fps !== null && s.fps !== undefined ? `${s.fps} fps` : null],
    ['الكودك', s.codec],
    ['المرمّز', s.hw === true ? 'كرت الشاشة' : s.hw === false ? 'المعالج (برمجي)' : s.impl, s.hw ? 'good' : ''],
    ['معدل الرفع', s.kbps !== null ? `${mbps(s.kbps)}${s.targetKbps ? ` / ${mbps(s.targetKbps)}` : ''}` : null],
    ['زمن الترميز', ms(s.encodeMs)],
    ['انتظار إرسال الحزم', ms(s.sendDelayMs)],
    ['ذهاب وعودة (RTT)', ms(s.rttMs)],
    ['فقد الحزم', s.lossPct !== null && s.lossPct !== undefined ? `${s.lossPct}%` : null, s.lossPct > 1 ? 'bad' : ''],
    ['عامل التقييد', s.limitation ? limitText : null, limitTone],
    ['مسار الإرسال', s.protocol?.toUpperCase()],
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
      {stats && <p className="hint">التأخير هنا يخص هذا الاتصال فقط. قياس التأخير الكامل يحتاج مقارنة ساعة المصدر بالمشاهدة. عدد إطارات المصدر لا يثبت أن محتوى كل إطار مختلف.</p>}
    </section>
  );
}
