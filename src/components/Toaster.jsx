import { TriangleAlert, Info } from 'lucide-react';
import { useStore } from '../lib/store';
import { dismissToast, toastStore } from '../ui/prefs';

export default function Toaster() {
  const items = useStore(toastStore, (s) => s.items);
  return (
    <div className="toaster" aria-live="polite">
      {items.map((t) => (
        <button key={t.id} className={`toast toast--${t.tone}`} onClick={() => dismissToast(t.id)}>
          {t.tone === 'warn' ? <TriangleAlert size={16} /> : <Info size={16} />}
          <span>{t.text}</span>
        </button>
      ))}
    </div>
  );
}
