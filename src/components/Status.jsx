import { LoaderCircle, Pause, WifiOff } from 'lucide-react';

const STATUS = {
  idle: { label: 'جاهز', chip: '' },
  connecting: { label: 'جارٍ الاتصال', chip: 'chip--accent', spin: true },
  reconnecting: { label: 'إعادة الاتصال', chip: 'chip--accent', spin: true },
  live: { label: 'مباشر', chip: 'chip--live', pulse: true },
  offline: { label: 'لا يوجد بث', chip: '' },
  unreachable: { label: 'السيرفر غير متصل', chip: '', icon: WifiOff },
  error: { label: 'خطأ في الاتصال', chip: 'chip--live' },
};

const HOLD = { label: 'استراحة', chip: 'chip--hold', icon: Pause };

function statusLabel(role, status, hold) {
  if (hold) return HOLD.label;
  if (role === 'host' && status === 'live') return 'على الهواء';
  return (STATUS[status] ?? STATUS.idle).label;
}

export function StatusText({ role, status, hold = false }) {
  return statusLabel(role, status, hold);
}

export function StatusPill({ role, status, hold = false }) {
  const s = hold ? HOLD : STATUS[status] ?? STATUS.idle;
  const Icon = s.icon;
  return (
    <span className={`chip status-pill ${s.chip}`} role="status" aria-live="polite">
      {s.spin ? (
        <LoaderCircle size={13} className="spin" />
      ) : Icon ? (
        <Icon size={13} />
      ) : (
        <span className={`dot ${s.pulse ? 'dot--pulse' : ''}`} />
      )}
      {statusLabel(role, status, hold)}
    </span>
  );
}

export function LatencyMeter({ ms }) {
  const level = ms < 150 ? 4 : ms < 300 ? 3 : ms < 600 ? 2 : 1;
  const tone = ms < 200 ? 'good' : ms < 450 ? 'mid' : 'bad';
  return (
    <span className={`meter meter--${tone}`} title="زمن التأخير التقديري — محسوب من getStats()">
      <span className="meter__bars" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <i key={i} data-on={i <= level} />
        ))}
      </span>
      <span className="num">{ms}</span>
      <small>ms</small>
    </span>
  );
}
