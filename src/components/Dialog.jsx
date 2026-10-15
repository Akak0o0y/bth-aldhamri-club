// Native <dialog>: focus trap, Esc and top-layer stacking come for free.
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';

// `required`: no Esc, backdrop or close button — the form inside must be done.
export default function Dialog({ title, subtitle, icon: Icon, onClose, size = 'md', required = false, children }) {
  const ref = useRef(null);
  const titleId = useId();
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  const requestClose = useCallback(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return onClose();
    setClosing(true);
    setTimeout(onClose, 160);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      className={`dialog dialog--${size} ${closing ? 'is-closing' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!required) requestClose();
      }}
      onClick={(e) => {
        if (!required && e.target === e.currentTarget) requestClose();
      }}
    >
      <div className="dialog__panel">
        <header className="dialog__head">
          {Icon && (
            <span className="dialog__icon">
              <Icon size={20} />
            </span>
          )}
          <div className="dialog__titles">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {!required && (
            <button className="btn btn--ghost btn--icon btn--sm" onClick={requestClose} aria-label="إغلاق">
              <X size={18} />
            </button>
          )}
        </header>
        <div className="dialog__body">{children}</div>
      </div>
    </dialog>
  );
}
