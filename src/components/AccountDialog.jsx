import { useEffect, useState } from 'react';
import { Check, Copy, LoaderCircle, LogIn, LogOut, Radio, UserPlus, UserRound } from 'lucide-react';
import { useStore } from '../lib/store';
import { authStore, createInvite, inviteCode, login, lookupInvite, register, signOut } from '../auth/session';
import { toast } from '../ui/prefs';
import Dialog from './Dialog';

const day = new Intl.DateTimeFormat('ar-SA', { weekday: 'long', day: 'numeric', month: 'long' });

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
          maxLength={24}
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
      <p className="hint">الاسم من 3 إلى 24 حرفاً أو رقماً. كلمة المرور 8 أحرف على الأقل.</p>
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

function AccountPanel({ onOpen }) {
  const [invite, setInvite] = useState(null); // { link, expires }
  const [copied, setCopied] = useState(false);
  const { busy, error, submit } = useSubmit(async () => {
    setInvite(await createInvite());
    setCopied(false);
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast('تعذر النسخ — انسخ الرابط يدوياً', 'warn');
    }
  };

  return (
    <>
      <form className="settings-group" onSubmit={submit}>
        <h3 className="settings-group__title">
          <UserPlus size={16} />
          دعوة مذيع
        </h3>
        <p className="settings-note">أنشئ رابطاً وأرسله لمن تريد أن يبث. كل رابط ينشئ حساباً واحداً وينتهي بعد أسبوع.</p>
        {invite && (
          <div className="settings-inline">
            <input className="field mono" value={invite.link} readOnly dir="ltr" onFocus={(e) => e.target.select()} aria-label="رابط الدعوة" />
            <button type="button" className="btn btn--sm btn--icon" onClick={copy} aria-label="نسخ الرابط" title="نسخ الرابط">
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
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
