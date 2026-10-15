import { useEffect, useRef, useState } from 'react';
import { UserRound } from 'lucide-react';
import { setPref } from '../ui/prefs';
import Dialog from './Dialog';

// A visitor's first stop on each device: the name the chat, the voice lounge
// and the "who's here" list show. It can't be skipped; it's kept per device.
export default function NameDialog({ onClose }) {
  const [name, setName] = useState('');
  const inputRef = useRef(null);

  // showModal() runs after this mounts and focuses the close button, so focus
  // the field on the next tick instead.
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const save = (e) => {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    setPref({ username: value });
    onClose();
  };

  return (
    <Dialog title="أهلاً بك في المجلس" subtitle="اكتب اسمك ليظهر في الشات والديوانية الصوتية" icon={UserRound} onClose={onClose} required>
      <form className="settings-group" onSubmit={save}>
        <label className="label" htmlFor="guest-name">
          اسمك
        </label>
        <div className="settings-inline">
          <input
            ref={inputRef}
            id="guest-name"
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
            autoComplete="nickname"
            dir="auto"
            required
          />
          <button type="submit" className="btn btn--primary" disabled={!name.trim()}>
            دخول المجلس
          </button>
        </div>
        <p className="settings-note">تقدر تغيّره في أي وقت من الإعدادات.</p>
      </form>
    </Dialog>
  );
}
