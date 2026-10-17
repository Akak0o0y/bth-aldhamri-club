import { useState } from 'react';
import { Check, Cloud, Copy, Eye, EyeOff, KeyRound, Leaf, Server, Settings2, User, Volume2, Zap } from 'lucide-react';
import { useStore } from '../lib/store';
import { CLOUD_MEDIAMTX_URL, configProblem, inviteLink, whepUrl } from '../stream/config';
import { setLowLatency, streamStore, updateConfig } from '../stream/controller';
import { soundFX } from '../services/soundEffects';
import { LOW_END, prefsStore, setPref, toast } from '../ui/prefs';
import Dialog from './Dialog';

export default function SettingsDialog({ onClose }) {
  const config = useStore(streamStore, (s) => s.config);
  const prefs = useStore(prefsStore, (s) => s);
  const [server, setServer] = useState(config.server);
  const [room, setRoom] = useState(config.room);
  const [name, setName] = useState(prefs.username);
  const [copied, setCopied] = useState(false);
  const [publishUser, setPublishUser] = useState(config.publishUser ?? '');
  const [publishPass, setPublishPass] = useState(config.publishPass ?? '');
  const [showPass, setShowPass] = useState(false);
  const credsDirty = publishUser.trim() !== (config.publishUser ?? '') || publishPass !== (config.publishPass ?? '');

  const draft = { server, room };
  const problem = configProblem(draft);
  const dirty = server.trim() !== config.server || room.trim() !== config.room;

  const save = (e) => {
    e.preventDefault();
    if (problem && !problem.includes('https')) return;
    updateConfig(draft);
    toast('تم حفظ السيرفر — جارٍ الاتصال');
  };

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink(config));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('تعذر النسخ', 'warn');
    }
  };

  return (
    <Dialog title="الإعدادات" subtitle="السيرفر، الأداء، والصوت" icon={Settings2} onClose={onClose}>
      <form className="settings-group" onSubmit={save}>
        <h3 className="settings-group__title">
          <Server size={16} />
          سيرفر البث
        </h3>
        <div className="settings-grid">
          <div>
            <label className="label" htmlFor="set-server">
              عنوان السيرفر (MediaMTX)
            </label>
            <div className="settings-inline">
              <input
                id="set-server"
                className="field mono"
                value={server}
                onChange={(e) => setServer(e.target.value)}
                placeholder={CLOUD_MEDIAMTX_URL}
                spellCheck="false"
                dir="ltr"
              />
              {server.trim() !== CLOUD_MEDIAMTX_URL && (
                <button
                  type="button"
                  className="btn btn--sm btn--icon"
                  onClick={() => setServer(CLOUD_MEDIAMTX_URL)}
                  aria-label="استخدم السيرفر السحابي"
                  title="استخدم السيرفر السحابي"
                >
                  <Cloud size={15} />
                </button>
              )}
            </div>
          </div>
          <div>
            <label className="label" htmlFor="set-room">
              اسم الغرفة
            </label>
            <input
              id="set-room"
              className="field mono"
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              placeholder="majlis"
              spellCheck="false"
              dir="ltr"
            />
          </div>
        </div>
        {problem && (
          <p className="settings-warn" role="alert">
            {problem}
          </p>
        )}
        <div className="settings-actions">
          <span className="mono faint settings-url">{whepUrl(config)}</span>
          <button type="button" className="btn btn--sm" onClick={copyInvite}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? 'تم' : 'رابط الدعوة'}
          </button>
          <button type="submit" className="btn btn--sm btn--primary" disabled={!dirty}>
            حفظ واتصال
          </button>
        </div>
      </form>

      <form
        className="settings-group"
        onSubmit={(e) => {
          e.preventDefault();
          updateConfig({ publishUser: publishUser.trim(), publishPass });
          toast('تم حفظ بيانات المضيف على هذا الجهاز');
        }}
      >
        <h3 className="settings-group__title">
          <KeyRound size={16} />
          بيانات المضيف — للبث فقط
        </h3>
        <p className="settings-note">
          السيرفر يسمح للجميع بالمشاهدة، لكن البث يحتاج اسم المستخدم وكلمة المرور. تُحفظ على هذا الجهاز فقط ولا تُرسل في رابط الدعوة.
        </p>
        <div className="settings-grid settings-grid--even">
          <div>
            <label className="label" htmlFor="set-puser">
              اسم المستخدم
            </label>
            <input
              id="set-puser"
              className="field mono"
              value={publishUser}
              onChange={(e) => setPublishUser(e.target.value)}
              autoComplete="username"
              spellCheck="false"
              dir="ltr"
            />
          </div>
          <div>
            <label className="label" htmlFor="set-ppass">
              كلمة المرور
            </label>
            <div className="settings-inline">
              <input
                id="set-ppass"
                className="field mono"
                type={showPass ? 'text' : 'password'}
                value={publishPass}
                onChange={(e) => setPublishPass(e.target.value)}
                autoComplete="current-password"
                spellCheck="false"
                dir="ltr"
              />
              <button
                type="button"
                className="btn btn--sm btn--icon"
                onClick={() => setShowPass((v) => !v)}
                aria-label={showPass ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
                title={showPass ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور'}
              >
                {showPass ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>
        </div>
        <div className="settings-actions">
          <span className="faint settings-url">
            {config.publishUser ? `محفوظ للمستخدم ${config.publishUser}` : 'لم تُحفظ بيانات بعد'}
          </span>
          <button type="submit" className="btn btn--sm btn--primary" disabled={!credsDirty}>
            حفظ
          </button>
        </div>
      </form>

      <div className="settings-group">
        <h3 className="settings-group__title">
          <Zap size={16} />
          الأداء
        </h3>
        <ToggleRow
          title="تأخير منخفض مع مخزن صغير"
          desc="يطلب مخزناً قدره 100 مللي ثانية لامتصاص تذبذب الشبكة. عند إطفائه يختار المتصفح المخزن تلقائياً."
          checked={prefs.lowLatency}
          onChange={(v) => setLowLatency(v)}
        />
        <ToggleRow
          title="وضع توفير الموارد"
          icon={Leaf}
          desc={`يثبّت الخلفية المتحركة ويوقف الحركات المتكررة.${LOW_END ? ' مُفعّل تلقائياً لأن جهازك محدود الموارد.' : ''}`}
          checked={prefs.eco}
          onChange={(v) => setPref({ eco: v })}
        />
      </div>

      <div className="settings-group">
        <h3 className="settings-group__title">
          <Volume2 size={16} />
          المؤثرات الصوتية
        </h3>
        <ToggleRow
          title="أصوات المجلس"
          desc="صب القهوة، الترحيب، التصفيق وتنبيه الشات."
          checked={prefs.sfx}
          onChange={(v) => {
            setPref({ sfx: v });
            soundFX.enabled = v;
          }}
        />
        <div className="settings-slider">
          <input
            type="range"
            className="range"
            min="0"
            max="100"
            value={prefs.sfxVolume}
            disabled={!prefs.sfx}
            aria-label="مستوى المؤثرات"
            style={{ '--pct': `${prefs.sfxVolume}%` }}
            onChange={(e) => {
              const v = Number(e.target.value);
              setPref({ sfxVolume: v });
              soundFX.setVolume(v);
            }}
            onPointerUp={() => soundFX.playCoffeePour()}
          />
          <span className="num faint">{prefs.sfxVolume}%</span>
        </div>
      </div>

      <form
        className="settings-group"
        onSubmit={(e) => {
          e.preventDefault();
          setPref({ username: name.trim() || 'ضيف المجلس' });
          toast('تم حفظ اسمك');
        }}
      >
        <h3 className="settings-group__title">
          <User size={16} />
          اسمك في الشات
        </h3>
        <div className="settings-inline">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
          <button type="submit" className="btn btn--sm" disabled={name.trim() === prefs.username}>
            حفظ
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ToggleRow({ title, desc, checked, onChange }) {
  return (
    <label className="toggle-row">
      <span className="toggle-row__text">
        <strong>{title}</strong>
        <span>{desc}</span>
      </span>
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="switch__track" />
      </span>
    </label>
  );
}
