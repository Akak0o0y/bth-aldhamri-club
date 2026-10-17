import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import ChatPanel from './components/ChatPanel';
import Header from './components/Header';
import NameDialog from './components/NameDialog';
import Player from './components/Player';
import StreamBar from './components/StreamBar';
import Toaster from './components/Toaster';
import VoiceLounge from './components/VoiceLounge';
import { authStore, checkSession, inviteCode } from './auth/session';
import { useStore } from './lib/store';
import { soundFX } from './services/soundEffects';
import { startViewing, stopViewing, streamStore } from './stream/controller';
import { prefsStore } from './ui/prefs';

// Dialogs are split out of the first load and prefetched when idle,
// so they still open instantly.
const loadStudio = () => import('./components/StudioDialog');
const loadSettings = () => import('./components/SettingsDialog');
const loadGuide = () => import('./components/GuideDialog');
const loadAccount = () => import('./components/AccountDialog');
const StudioDialog = lazy(loadStudio);
const SettingsDialog = lazy(loadSettings);
const GuideDialog = lazy(loadGuide);
const AccountDialog = lazy(loadAccount);

// The default chat name in ui/prefs.js until a visitor picks their own.
const GUEST_NAME = 'ضيف المجلس';
// Every device needs a name (streamers use their account's).
const needsName = () => !authStore.get().name && prefsStore.get().username === GUEST_NAME;

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
  const broadcasting = useStore(streamStore, (s) => s.role === 'host');
  const theater = useStore(prefsStore, (s) => s.theater);
  // A streamer invite (?invite=CODE) opens straight onto the sign-up form; any
  // other visitor without a name yet is asked for one for the chat and mic,
  // and closing another dialog brings that question back until it's answered.
  const [dialog, setDialog] = useState(() => {
    if (inviteCode()) return 'account';
    return needsName() ? 'name' : null;
  });
  const close = useCallback(() => setDialog(needsName() ? 'name' : null), []);

  useEffect(() => {
    const { sfx, sfxVolume } = prefsStore.get();
    soundFX.enabled = sfx;
    soundFX.setVolume(sfxVolume);
    startViewing();
    checkSession();
    document.addEventListener('pointerdown', ripple);

    const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1500));
    idle(() => {
      loadStudio();
      loadSettings();
      loadGuide();
      loadAccount();
    });
    return () => {
      stopViewing();
      document.removeEventListener('pointerdown', ripple);
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('eco', eco || broadcasting);
  }, [eco, broadcasting]);

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
        {dialog === 'account' && <AccountDialog onClose={close} onOpen={setDialog} />}
        {dialog === 'name' && <NameDialog onClose={close} />}
      </Suspense>

      <Toaster />
    </div>
  );
}
