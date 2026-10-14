import { memo, useEffect, useRef, useState } from 'react';
import { ChartColumn, Coffee, Flame, HandHeart, Heart, MessageCircle, Send, Star, Volume2, VolumeX, WifiOff } from 'lucide-react';
import { useStore } from '../lib/store';
import { castVote, rtStore, sendChat, sendReaction, startRealtime } from '../realtime/channel';
import { soundFX } from '../services/soundEffects';
import { prefsStore, setPref } from '../ui/prefs';

const ICONS = { coffee: Coffee, fire: Flame, clap: HandHeart, star: Star, heart: Heart };

const SOUNDBOARD = [
  { key: 'coffee', label: 'صب القهوة', text: 'صب القهوة يا راعي المجلس' },
  { key: 'fire', label: 'كفووو', text: 'كفووو يالذيب والله' },
  { key: 'clap', label: 'تصفيق', text: 'تحية وتصفيق للمجلس' },
  { key: 'star', label: 'ترحيب', text: 'حي الله الوجيه الطيبة' },
];

const PHRASES = [
  ['أرحبوا', 'أرحبوا تراحيب المطر'],
  ['ما شاء الله', 'ما شاء الله تبارك الرحمن'],
  ['عاش البث', 'عاش البث والوضوح'],
];

const POLL = [
  { id: 'games', label: 'بطولة ألعاب وتحديات' },
  { id: 'talk', label: 'سوالف وقهوة المجلس' },
  { id: 'night', label: 'سهرة ومتابعة خاصة' },
];

const clock = new Intl.DateTimeFormat('ar-SA', { hour: 'numeric', minute: '2-digit' });

const Message = memo(function Message({ m, mine }) {
  const Icon = ICONS[m.icon];
  return (
    <li className={`msg msg--${mine ? 'me' : m.host ? 'host' : 'member'}`}>
      <span className="msg__avatar" aria-hidden="true">
        {m.name.trim().charAt(0)}
      </span>
      <div className="msg__body">
        <div className="msg__meta">
          <strong>{m.name}</strong>
          {m.host && <span className="msg__badge">راعي المجلس</span>}
          <time>{clock.format(m.ts)}</time>
        </div>
        <p className="msg__text">
          {Icon && <Icon size={14} aria-hidden="true" />} {m.text}
        </p>
      </div>
    </li>
  );
});

function Poll() {
  const votes = useStore(rtStore, (s) => s.votes);
  const myVote = useStore(rtStore, (s) => s.myVote);
  const open = useStore(rtStore, (s) => s.status === 'open');
  const total = POLL.reduce((sum, p) => sum + (votes[p.id] || 0), 0);

  return (
    <section className="poll" aria-label="تصويت">
      <div className="poll__head">
        <ChartColumn size={15} />
        وش المحتوى القادم؟
        <span className="faint num poll__total">{total} صوت</span>
      </div>
      {POLL.map((p) => {
        const pct = total ? (votes[p.id] || 0) / total : 0;
        return (
          <button
            key={p.id}
            className={`poll__opt ${myVote === p.id ? 'is-voted' : ''}`}
            onClick={() => {
              castVote(p.id);
              soundFX.playRoyalChime();
            }}
            disabled={Boolean(myVote) || !open}
          >
            <span className="poll__bar" style={{ '--p': myVote ? pct : 0 }} />
            <span>{p.label}</span>
            {myVote && <span className="num">{Math.round(pct * 100)}%</span>}
          </button>
        );
      })}
    </section>
  );
}

// Owns the draft text, so typing re-renders only the input — not the list.
function Composer({ onSent }) {
  const [text, setText] = useState('');
  const open = useStore(rtStore, (s) => s.status === 'open');

  const send = (e) => {
    e.preventDefault();
    const value = text.trim();
    if (!value || !sendChat(value)) return;
    setText('');
    onSent();
    soundFX.playChatNotification();
  };

  const playSound = (item) => {
    sendReaction(item.key);
    if (sendChat(item.text, item.key)) onSent();
  };

  return (
    <>
      <div className="chat__tools">
        <div className="soundboard">
          {SOUNDBOARD.map((item) => {
            const Icon = ICONS[item.key];
            return (
              <button key={item.key} className="sound-btn" onClick={() => playSound(item)} disabled={!open}>
                <Icon size={16} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
        <div className="phrases">
          {PHRASES.map(([label, phrase]) => (
            <button key={label} className="phrase" onClick={() => setText(phrase)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <form className="composer" onSubmit={send}>
        <input
          className="field"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={open ? 'اكتب رسالتك للمجلس…' : 'جارٍ الاتصال بالمجلس…'}
          aria-label="رسالة"
          maxLength={400}
        />
        <button type="submit" className="btn btn--brass composer__send" aria-label="إرسال" disabled={!text.trim() || !open}>
          <Send size={18} />
        </button>
      </form>
    </>
  );
}

function ChatPanel() {
  const sfx = useStore(prefsStore, (s) => s.sfx);
  const eco = useStore(prefsStore, (s) => s.eco);
  const messages = useStore(rtStore, (s) => s.messages);
  const you = useStore(rtStore, (s) => s.you);
  const status = useStore(rtStore, (s) => s.status);
  const listRef = useRef(null);
  const stickRef = useRef(true);

  useEffect(() => startRealtime(), []);

  // Follow new messages only while the reader is at the bottom.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTo({ top: el.scrollHeight, behavior: eco ? 'auto' : 'smooth' });
  }, [messages, eco]);

  const offline = status === 'closed';

  return (
    <aside className="chat rise" style={{ '--i': 2 }} aria-label="شات المجلس">
      <header className="chat__head">
        <h3>
          <MessageCircle size={17} />
          شات المجلس
          <span className="chat__count num">{messages.length}</span>
        </h3>
        <button
          className="btn btn--ghost btn--icon btn--sm"
          onClick={() => {
            setPref({ sfx: !sfx });
            soundFX.enabled = !sfx;
          }}
          aria-label={sfx ? 'كتم أصوات المجلس' : 'تشغيل أصوات المجلس'}
          title={sfx ? 'كتم أصوات المجلس' : 'تشغيل أصوات المجلس'}
        >
          {sfx ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </button>
      </header>

      <Poll />

      <ul
        ref={listRef}
        className="chat__list"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {messages.length ? (
          messages.map((m) => <Message key={m.id} m={m} mine={m.from === you} />)
        ) : (
          <li className="empty">
            {offline ? <WifiOff size={22} /> : <MessageCircle size={22} />}
            <strong>{offline ? 'تعذر الاتصال بالمجلس' : 'المجلس هادئ'}</strong>
            <span>{offline ? 'نعيد المحاولة تلقائياً' : status === 'open' ? 'ابدأ السالفة بأول رسالة' : 'جارٍ الاتصال…'}</span>
          </li>
        )}
      </ul>

      <Composer
        onSent={() => {
          stickRef.current = true;
        }}
      />
    </aside>
  );
}

export default memo(ChatPanel);
