import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import ChatPanel from './components/ChatPanel';
import Header from './components/Header';
import Player from './components/Player';
import StreamBar from './components/StreamBar';
import Toaster from './components/Toaster';
import VoiceLounge from './components/VoiceLounge';
import { useStore } from './lib/store';
import { soundFX } from './services/soundEffects';
import { startViewing, stopViewing } from './stream/controller';
import { prefsStore } from './ui/prefs';

// Dialogs are split out of the first load and prefetched when idle,
// so they still open instantly.
const loadStudio = () => import('./components/StudioDialog');
const loadSettings = () => import('./components/SettingsDialog');
const loadGuide = () => import('./components/GuideDialog');
const StudioDialog = lazy(loadStudio);
const SettingsDialog = lazy(loadSettings);
const GuideDialog = lazy(loadGuide);

// One delegated listener gives every pressable control a ripple from the
// exact press point (CSS: .rippling::after).
const PRESSABLE =
  '.btn, .ctl, .seg__opt, .preset, .codec, .guide-tab, .sound-btn, .phrase, .poll__opt, .latency-toggle, .quick-react button';

function ripple(e) {
  if (e.button !== 0) return;
  const el = e.target.closest?.(PRESSABLE);
  if (!el || el.disabled) return;
  const rect = el.getBoundingClientRect();
  el.style.setProperty('--rx', `${e.clientX - rect.left}px`);
  el.style.setProperty('--ry', `${e.clientY - rect.top}px`);
  el.classList.remove('rippling');
  void el.offsetWidth; // restart the animation on rapid presses
  el.classList.add('rippling');
}

export default function App() {
  const eco = useStore(prefsStore, (s) => s.eco);
  const theater = useStore(prefsStore, (s) => s.theater);
  const [dialog, setDialog] = useState(null);
  const close = useCallback(() => setDialog(null), []);

  useEffect(() => {
    const { sfx, sfxVolume } = prefsStore.get();
    soundFX.enabled = sfx;
    soundFX.setVolume(sfxVolume);
    startViewing();
    document.addEventListener('pointerdown', ripple);

    const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500));
    idle(() => {
      loadStudio();
      loadSettings();
      loadGuide();
    });
    return () => {
      stopViewing();
      document.removeEventListener('pointerdown', ripple);
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('eco', eco);
  }, [eco]);

  return (
    <div className={`app ${theater ? 'is-theater' : ''}`}>
      <div className="backdrop" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <Header onOpen={setDialog} />

      <main className="layout">
        <section className="stage">
          <Player onOpen={setDialog} />
          <StreamBar />
          <VoiceLounge />
        </section>
        <ChatPanel />
      </main>

      <Suspense fallback={null}>
        {dialog === 'studio' && <StudioDialog onClose={close} onOpen={setDialog} />}
        {dialog === 'settings' && <SettingsDialog onClose={close} />}
        {dialog === 'guide' && <GuideDialog onClose={close} />}
      </Suspense>

      <Toaster />
    </div>
  );
}
