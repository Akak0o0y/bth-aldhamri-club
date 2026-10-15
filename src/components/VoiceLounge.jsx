import { Fragment, memo } from 'react';
import { Crown, Hand, HeadphoneOff, Headphones, LogOut, Mic, MicOff } from 'lucide-react';
import { useStore } from '../lib/store';
import { rtStore } from '../realtime/channel';
import { joinVoice, leaveVoice, toggleDeaf, toggleHand, toggleMic, voiceStore } from '../realtime/voice';

function statusText(m, talking) {
  if (talking) return 'يتحدث الآن';
  if (m.mic) return 'المايك مفتوح';
  if (m.hand) return 'يطلب الكلمة';
  return 'يستمع';
}

function VoiceLounge() {
  const members = useStore(rtStore, (s) => s.voice);
  const online = useStore(rtStore, (s) => s.online);
  const people = useStore(rtStore, (s) => s.people);
  const you = useStore(rtStore, (s) => s.you);
  const open = useStore(rtStore, (s) => s.status === 'open');
  const joined = useStore(voiceStore, (s) => s.joined);
  const mic = useStore(voiceStore, (s) => s.mic);
  const deaf = useStore(voiceStore, (s) => s.deaf);
  const hand = useStore(voiceStore, (s) => s.hand);
  const speaking = useStore(voiceStore, (s) => s.speaking);

  return (
    <section className="lounge rise" style={{ '--i': 3 }} aria-label="الديوانية الصوتية">
      <header className="lounge__head">
        <div>
          <h3>
            <Headphones size={17} />
            الديوانية الصوتية
          </h3>
          <p>
            <span className="num">{online}</span> في المجلس · <span className="num">{members.length}</span> في الديوانية
          </p>
          {people.length > 0 && (
            <p title={people.join('، ')}>
              الحضور:{' '}
              {people.slice(0, 12).map((name, i) => (
                <Fragment key={i}>
                  {i > 0 && '، '}
                  <bdi>{name}</bdi>
                </Fragment>
              ))}
              {people.length > 12 && ` و${people.length - 12} آخرين`}
            </p>
          )}
        </div>
        <div className="lounge__actions">
          {joined ? (
            <>
              <button className="btn btn--sm" aria-pressed={hand} onClick={toggleHand}>
                <Hand size={15} />
                {hand ? 'طلبت الكلمة' : 'طلب الكلمة'}
              </button>
              <button
                className="btn btn--sm btn--icon"
                aria-pressed={deaf}
                onClick={toggleDeaf}
                aria-label={deaf ? 'تشغيل صوت الديوانية' : 'كتم صوت الديوانية'}
                title={deaf ? 'تشغيل صوت الديوانية' : 'كتم صوت الديوانية'}
              >
                {deaf ? <HeadphoneOff size={15} /> : <Headphones size={15} />}
              </button>
              <button className={`btn btn--sm ${mic === 'off' ? '' : 'btn--accent'}`} aria-pressed={mic !== 'off'} onClick={toggleMic}>
                {mic === 'off' ? <MicOff size={15} /> : <Mic size={15} />}
                {mic === 'off' ? 'افتح المايك' : mic === 'live' ? 'المايك مفتوح' : 'جارٍ الاتصال…'}
              </button>
              <button className="btn btn--sm btn--icon" onClick={leaveVoice} aria-label="مغادرة الديوانية" title="مغادرة الديوانية">
                <LogOut size={15} />
              </button>
            </>
          ) : (
            <button className="btn btn--sm btn--primary" onClick={joinVoice} disabled={!open}>
              <Headphones size={15} />
              انضم للديوانية
            </button>
          )}
        </div>
      </header>

      {members.length ? (
        <ul className="lounge__members">
          {members.map((m) => {
            const talking = speaking.includes(m.id);
            return (
              <li key={m.id} className={`member ${talking ? 'is-speaking' : ''}`}>
                <span className="member__avatar" aria-hidden="true">
                  {m.name.trim().charAt(0)}
                </span>
                <span className="member__info">
                  <strong>
                    {m.id === you ? `${m.name} (أنت)` : m.name}
                    {m.host && <Crown size={12} className="member__crown" />}
                  </strong>
                  <span>{statusText(m, talking)}</span>
                </span>
                {talking && (
                  <span className="eq" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="empty">
          <Headphones size={22} />
          <strong>الديوانية فاضية</strong>
          <span>انضم وافتح المايك ليسمعك الحضور</span>
        </div>
      )}
    </section>
  );
}

export default memo(VoiceLounge);
