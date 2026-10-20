import { Cpu, Gauge, Signal } from 'lucide-react';
import { useStore } from '../lib/store';
import { rtStore } from '../realtime/channel';
import { streamStore } from '../stream/controller';
import { StatusText } from './Status';

function resolutionLabel(stats) {
  if (!stats?.height) return null;
  const h = stats.height;
  const name = h >= 2100 ? '4K' : h >= 1400 ? '1440p' : `${h}p`;
  return stats.fps ? `${name} · ${stats.fps}fps` : name;
}

export default function StreamBar() {
  const stats = useStore(streamStore, (s) => s.stats);
  const role = useStore(streamStore, (s) => s.role);
  const status = useStore(streamStore, (s) => s.status);
  const config = useStore(streamStore, (s) => s.config);
  const hwDecode = useStore(streamStore, (s) => s.hwDecode);
  const publish = useStore(streamStore, (s) => s.publish);
  const viewerHold = useStore(rtStore, (s) => Boolean(s.hold));
  const hold = role === 'host' ? Boolean(publish?.hold) : viewerHold;

  const res = resolutionLabel(stats);
  const hw = role === 'host' ? stats?.hw ?? null : hwDecode;

  return (
    <div className="streambar rise" style={{ '--i': 2 }}>
      <div className="streambar__title">
        <h2>مجلس ظمرة</h2>
        <p>
          <span>
            الغرفة <span className="mono">{config.room}</span>
          </span>
          <span className="streambar__sep" />
          <span>
            <StatusText role={role} status={status} hold={hold} />
          </span>
        </p>
      </div>

      <div className="streambar__chips">
        {res && (
          <span className="chip chip--accent">
            <Gauge size={13} />
            <span className="num">{res}</span>
          </span>
        )}
        {(stats?.codec || publish?.codecLabel) && <span className="chip num">{stats?.codec ?? publish.codecLabel}</span>}
        {stats?.kbps !== null && stats?.kbps !== undefined && (
          <span className="chip">
            <Signal size={13} />
            <span className="num">{(stats.kbps / 1000).toFixed(1)} Mbps</span>
          </span>
        )}
        {hw !== null && hw !== undefined && (
          <span className={`chip ${hw ? 'chip--good' : ''}`} title={hw ? 'يعمل على كرت الشاشة — أقل استهلاك للمعالج' : 'يعمل على المعالج'}>
            <Cpu size={13} />
            {hw ? 'تسريع بالعتاد' : 'معالجة برمجية'}
          </span>
        )}
        {!stats && (
          <span className="chip mono streambar__server" title="عنوان سيرفر البث">
            {config.server.replace(/^https?:\/\//, '')}/{config.room}
          </span>
        )}
      </div>
    </div>
  );
}
