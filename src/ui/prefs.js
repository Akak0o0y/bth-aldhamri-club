// Viewer preferences + two tiny event channels (reactions, toasts) kept
// outside React state so firing a reaction doesn't re-render the app.
import { createStore, readJSON, writeJSON } from '../lib/store';

const KEY = 'majlis.prefs.v1';

// Weak machines start in eco mode: no ambient glow, no looping animations.
export const LOW_END =
  (navigator.hardwareConcurrency || 8) <= 4 ||
  (navigator.deviceMemory || 8) <= 4 ||
  matchMedia('(prefers-reduced-motion: reduce)').matches;

const defaults = {
  eco: LOW_END,
  sfx: true,
  sfxVolume: 70,
  username: 'ضيف المجلس',
  volume: 1,
  muted: false,
  lowLatency: true,
  theater: false,
};

export const prefsStore = createStore(readJSON(KEY, defaults));

export function setPref(patch) {
  prefsStore.set(patch);
  writeJSON(KEY, prefsStore.get());
}

// --- reactions -------------------------------------------------------------

export const reactionsStore = createStore({ items: [] });
let reactionId = 0;

// key: 'heart' | 'fire' | 'clap' | 'star' | 'coffee' (rendered as icons by the player)
export function emitReaction(key) {
  const id = ++reactionId;
  const item = { id, key, x: 12 + Math.random() * 76, drift: Math.round((Math.random() - 0.5) * 80) };
  reactionsStore.set((s) => ({ items: [...s.items.slice(-11), item] }));
  setTimeout(() => reactionsStore.set((s) => ({ items: s.items.filter((r) => r.id !== id) })), 2600);
}

// --- toasts ----------------------------------------------------------------

export const toastStore = createStore({ items: [] });
let toastId = 0;

export function dismissToast(id) {
  toastStore.set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

export function toast(text, tone = 'info') {
  const id = ++toastId;
  toastStore.set((s) => ({ items: [...s.items.slice(-2), { id, text, tone }] }));
  setTimeout(() => dismissToast(id), 4200);
}
