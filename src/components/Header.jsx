import { useState } from 'react';
import { Check, Link2, Radio, Server, Settings2, UserRound } from 'lucide-react';
import { authStore } from '../auth/session';
import { useStore } from '../lib/store';
import { rtStore } from '../realtime/channel';
import { inviteLink } from '../stream/config';
import { streamStore } from '../stream/controller';
import { soundFX } from '../services/soundEffects';
import { toast } from '../ui/prefs';
import { BrandMark } from './Brand';
import { LatencyMeter, StatusPill } from './Status';

export default function Header({ onOpen }) {
  const role = useStore(streamStore, (s) => s.role);
  const status = useStore(streamStore, (s) => s.status);
  const latency = useStore(streamStore, (s) => s.stats?.latencyMs ?? null);
  const config = useStore(streamStore, (s) => s.config);
  const hostHold = useStore(streamStore, (s) => Boolean(s.publish?.hold));
  const viewerHold = useStore(rtStore, (s) => Boolean(s.hold));
  const account = useStore(authStore, (s) => s.name);
  const [copied, setCopied] = useState(false);

  const invite = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink(config));
      soundFX.playChatNotification();
      setCopied(true);
      toast('تم نسخ رابط الدعوة — أرسله للقروب');
      setTimeout(() => setCopied(false), 2200);
    } catch {
      toast('تعذر النسخ — انسخ الرابط من شريط العنوان', 'warn');
    }
  };

  return (
    <header className="topbar rise">
      <div className="topbar__brand">
        <BrandMark />
        <div className="topbar__name">
          <h1>مجلس ظمرة</h1>
          <span>ديوانية البث المباشر</span>
        </div>
      </div>

      <div className="topbar__status">
        <StatusPill role={role} status={status} hold={role === 'host' ? hostHold : viewerHold} />
        {latency !== null && status === 'live' && <LatencyMeter ms={latency} />}
      </div>

      <nav className="topbar__actions" aria-label="إجراءات">
        <button className="btn btn--ghost topbar__invite" onClick={invite}>
          {copied ? <Check size={17} /> : <Link2 size={17} />}
          <span>{copied ? 'تم النسخ' : 'دعوة'}</span>
        </button>
        <button
          className="btn btn--ghost topbar__invite"
          onClick={() => onOpen('account')}
          aria-label={account ? `حسابي: ${account}` : 'دخول المذيعين'}
          title={account ? `حسابي: ${account}` : 'دخول المذيعين'}
        >
          <UserRound size={17} />
          <span>{account || 'دخول'}</span>
        </button>
        <button className="btn btn--ghost btn--icon" onClick={() => onOpen('guide')} aria-label="سيرفرات البث" title="سيرفرات البث">
          <Server size={18} />
        </button>
        <button className="btn btn--ghost btn--icon" onClick={() => onOpen('settings')} aria-label="الإعدادات" title="الإعدادات">
          <Settings2 size={18} />
        </button>
        {role === 'host' ? (
          <button className="btn btn--live" onClick={() => onOpen('studio')}>
            <span className="dot dot--pulse" />
            <span>لوحة البث</span>
          </button>
        ) : (
          <button className="btn btn--primary" onClick={() => onOpen('studio')}>
            <Radio size={17} />
            <span>ابدأ البث</span>
          </button>
        )}
      </nav>
    </header>
  );
}
