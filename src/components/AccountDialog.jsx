import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound, LoaderCircle, LogIn, LogOut, Radio, Trash2, Tv, UserPlus, UserRound, Users } from 'lucide-react';
import { useStore } from '../lib/store';
import {
  authStore,
  changePassword,
  createInvite,
  inviteCode,
  loadMembers,
  login,
  lookupInvite,
  register,
  removeUser,
  revokeInvite,
  signOut,
} from '../auth/session';
import { inviteLink } from '../stream/config';
import { streamStore, updateConfig } from '../stream/controller';
import { toast } from '../ui/prefs';
import Dialog from './Dialog';

const day = new Intl.DateTimeFormat('ar-SA', { weekday: 'long', day: 'numeric', month: 'long' });
const date = new Intl.DateTimeFormat('ar-SA', { day: 'numeric', month: 'long', year: 'numeric' });

export default function AccountDialog({ onClose, onOpen }) {
  const name = useStore(authStore, (s) => s.name);
  const [code] = useState(inviteCode);

  if (name) {
    return (
      <Dialog title="حسابي" subtitle={`مسجّل باسم ${name}`} icon={UserRound} onClose={onClose}>
        <AccountPanel onOpen={onOpen} />
      </Dialog>
    );
  }
  if (code) {
    return (
      <Dialog title="حساب مذيع جديد" subtitle="أنشئ حسابك لتبث في المجلس" icon={UserPlus} onClose={onClose}>
        <RegisterForm code={code} />
      </Dialog>
    );
  }
  return (
    <Dialog title="دخول المذيعين" subtitle="البث لأصحاب الحسابات — المشاهدة متاحة للجميع" icon={LogIn} onClose={onClose}>
      <LoginForm />
    </Dialog>
  );
}

// Shared submit handling: busy state, error line, no double submits.
function useSubmit(action) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

function Credentials({ name, setName, pass, setPass, newAccount }) {
  return (
    <div className="settings-grid settings-grid--even">
      <div>
        <label className="label" htmlFor="acc-name">
          اسم المستخدم
        </label>
        <input
          id="acc-name"
          className="field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="username"
          spellCheck="false"
          maxLength={64}
          dir="auto"
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="acc-pass">
          كلمة المرور
        </label>
        <input
          id="acc-pass"
          className="field"
          type="password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          autoComplete={newAccount ? 'new-password' : 'current-password'}
          minLength={newAccount ? 8 : undefined}
          dir="ltr"
          required
        />
      </div>
    </div>
  );
}

function LoginForm() {
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    await login(name, pass);
    toast(`أهلاً ${name.trim()} — تقدر تبث الآن`);
  });

  return (
    <form className="settings-group" onSubmit={submit}>
      <Credentials name={name} setName={setName} pass={pass} setPass={setPass} />
      {error && (
        <p className="settings-warn" role="alert">
          {error}
        </p>
      )}
      <p className="settings-note">ما عندك حساب؟ اطلب رابط دعوة من أي مذيع في المجلس.</p>
      <div className="settings-actions">
        <button type="submit" className="btn btn--primary" disabled={busy || !name.trim() || !pass}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <LogIn size={16} />}
          دخول
        </button>
      </div>
    </form>
  );
}

function RegisterForm({ code }) {
  const [invite, setInvite] = useState(null); // { by } | { error }
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    await register(code, name, pass);
    toast(`مرحباً ${name.trim()} — صار عندك حساب مذيع`);
  });

  useEffect(() => {
    lookupInvite(code).then(setInvite, (err) => setInvite({ error: err.message }));
  }, [code]);

  if (!invite) {
    return (
      <div className="empty">
        <LoaderCircle size={22} className="spin" />
        <span>نتحقق من رابط الدعوة…</span>
      </div>
    );
  }
  if (invite.error) {
    return (
      <div className="empty">
        <UserPlus size={22} />
        <strong>الدعوة غير صالحة</strong>
        <span>{invite.error}</span>
      </div>
    );
  }

  return (
    <form className="settings-group" onSubmit={submit}>
      <p className="settings-note">
        دعاك <b>{invite.by}</b> لتكون مذيعاً في المجلس. الرابط صالح لحساب واحد فقط.
      </p>
      <Credentials name={name} setName={setName} pass={pass} setPass={setPass} newAccount />
      <p className="hint">الاسم من 3 إلى 64 حرفاً أو رقماً، ويصلح البريد الإلكتروني. كلمة المرور 8 أحرف على الأقل.</p>
      {error && (
        <p className="settings-warn" role="alert">
          {error}
        </p>
      )}
      <div className="settings-actions">
        <button type="submit" className="btn btn--primary" disabled={busy || !name.trim() || pass.length < 8}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <UserPlus size={16} />}
          إنشاء الحساب
        </button>
      </div>
    </form>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('تعذر النسخ — انسخ الرابط يدوياً', 'warn');
    }
  };
  return (
    <button type="button" className="btn btn--sm btn--icon" onClick={copy} aria-label="نسخ الرابط" title="نسخ الرابط">
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}

// The streamer's own channel: the link their audience opens to watch and chat.
function ChannelLink() {
  const room = useStore(authStore, (s) => s.room);
  const config = useStore(streamStore, (s) => s.config);
  if (!room) return null;
  const link = inviteLink({ server: config.server, room });

  return (
    <div className="settings-group">
      <h3 className="settings-group__title">
        <Tv size={16} />
        قناتك
      </h3>
      <p className="settings-note">أرسل هذا الرابط لجمهورك: يفتح بثك والشات الخاص بقناتك. الشات يبدأ من جديد مع كل بث.</p>
      <div className="settings-inline">
        <input className="field mono" value={link} readOnly dir="ltr" onFocus={(e) => e.target.select()} aria-label="رابط قناتك" />
        <CopyButton text={link} />
      </div>
      {config.room !== room && (
        <div className="settings-actions">
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => {
              updateConfig({ room });
              toast('انتقلت إلى قناتك');
            }}
          >
            <Tv size={15} />
            افتح قناتك
          </button>
        </div>
      )}
    </div>
  );
}

function AccountPanel({ onOpen }) {
  const owner = useStore(authStore, (s) => s.owner);
  const [invite, setInvite] = useState(null); // { link, expires }
  // Bumped after every change so the owner's lists reload.
  const [rev, setRev] = useState(0);
  const { busy, error, submit } = useSubmit(async () => {
    setInvite(await createInvite());
    setRev((n) => n + 1);
  });

  return (
    <>
      <ChannelLink />

      <form className="settings-group" onSubmit={submit}>
        <h3 className="settings-group__title">
          <UserPlus size={16} />
          دعوة مذيع
        </h3>
        <p className="settings-note">أنشئ رابطاً وأرسله لمن تريد أن يبث. كل رابط ينشئ حساباً واحداً وينتهي بعد أسبوع.</p>
        {invite && (
          <div className="settings-inline">
            <input className="field mono" value={invite.link} readOnly dir="ltr" onFocus={(e) => e.target.select()} aria-label="رابط الدعوة" />
            <CopyButton key={invite.link} text={invite.link} />
          </div>
        )}
        {error && (
          <p className="settings-warn" role="alert">
            {error}
          </p>
        )}
        <div className="settings-actions">
          <span className="faint settings-url">{invite ? `صالح حتى ${day.format(invite.expires)}` : ''}</span>
          <button type="submit" className="btn btn--sm" disabled={busy}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <UserPlus size={15} />}
            {invite ? 'رابط جديد' : 'إنشاء رابط دعوة'}
          </button>
        </div>
      </form>

      {owner && <Members rev={rev} onChange={() => setRev((n) => n + 1)} />}
      <PasswordForm />

      <div className="settings-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            signOut();
            toast('تم تسجيل الخروج');
          }}
        >
          <LogOut size={16} />
          تسجيل الخروج
        </button>
        <button type="button" className="btn btn--primary" onClick={() => onOpen('studio')}>
          <Radio size={16} />
          ابدأ البث
        </button>
      </div>
    </>
  );
}

function PasswordForm() {
  const name = useStore(authStore, (s) => s.name);
  const [current, setCurrent] = useState('');
  const [pass, setPass] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    await changePassword(current, pass);
    setCurrent('');
    setPass('');
    toast('تم تغيير كلمة المرور');
  });

  return (
    <form className="settings-group" onSubmit={submit}>
      <h3 className="settings-group__title">
        <KeyRound size={16} />
        تغيير كلمة المرور
      </h3>
      {/* Tells password managers which account the new password belongs to. */}
      <input type="text" value={name} autoComplete="username" readOnly hidden />
      <div className="settings-grid settings-grid--even">
        <div>
          <label className="label" htmlFor="acc-current">
            كلمة المرور الحالية
          </label>
          <input
            id="acc-current"
            className="field"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            dir="ltr"
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="acc-new">
            كلمة المرور الجديدة
          </label>
          <input
            id="acc-new"
            className="field"
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            dir="ltr"
            required
          />
        </div>
      </div>
      {error && (
        <p className="settings-warn" role="alert">
          {error}
        </p>
      )}
      <div className="settings-actions">
        <span className="faint settings-url">8 أحرف على الأقل. تغييرها يُخرج أجهزتك الأخرى من الحساب.</span>
        <button type="submit" className="btn btn--sm" disabled={busy || !current || pass.length < 8}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <KeyRound size={15} />}
          حفظ
        </button>
      </div>
    </form>
  );
}

// Owner only. Removing anything takes a second click on the same button.
function Members({ rev, onChange }) {
  const [data, setData] = useState(null); // { users, invites } | { error }
  const [armed, setArmed] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let live = true;
    loadMembers().then(
      (d) => live && setData(d),
      (err) => live && setData({ error: err.message }),
    );
    return () => {
      live = false;
    };
  }, [rev]);

  const remove = async (id, run, done) => {
    if (armed !== id) {
      setArmed(id);
      return;
    }
    setArmed('');
    setBusy(id);
    try {
      await run();
      toast(done);
      onChange();
    } catch (err) {
      toast(err.message, 'warn');
    } finally {
      setBusy('');
    }
  };

  const removeButton = (id, label, run, done) => (
    <button type="button" className="btn btn--sm" disabled={busy === id} onClick={() => remove(id, run, done)} onBlur={() => setArmed('')}>
      {busy === id ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}
      {armed === id ? 'تأكيد' : label}
    </button>
  );

  return (
    <>
      <div className="settings-group">
        <h3 className="settings-group__title">
          <Users size={16} />
          المذيعون
          {data?.users && <span className="faint num">{data.users.length}</span>}
        </h3>
        {!data && <p className="settings-note">نحمّل القائمة…</p>}
        {data?.error && (
          <p className="settings-warn" role="alert">
            {data.error}
          </p>
        )}
        {data?.users && (
          <div>
            {data.users.map((u) => (
              <div className="copy-row" key={u.name}>
                <span className="copy-row__val">
                  <bdi>{u.name}</bdi>
                  <span className="faint">
                    {' — '}
                    {u.by ? (
                      <>
                        دعاه <bdi>{u.by}</bdi>
                      </>
                    ) : (
                      'صاحب المجلس'
                    )}
                    ، {date.format(u.created)}
                  </span>
                </span>
                {u.by && removeButton(`u:${u.name}`, 'حذف', () => removeUser(u.name), `حُذف حساب ${u.name}`)}
              </div>
            ))}
          </div>
        )}
      </div>

      {data?.invites?.length > 0 && (
        <div className="settings-group">
          <h3 className="settings-group__title">
            <UserPlus size={16} />
            دعوات لم تُستخدم
          </h3>
          <div>
            {data.invites.map((i) => (
              <div className="copy-row" key={i.code}>
                <span className="copy-row__val">
                  <span className="mono">{i.code.slice(0, 6)}…</span>
                  <span className="faint">
                    {' — من '}
                    <bdi>{i.by}</bdi>، حتى {day.format(i.expires)}
                  </span>
                </span>
                {removeButton(`i:${i.code}`, 'إلغاء', () => revokeInvite(i.code), 'أُلغيت الدعوة')}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
