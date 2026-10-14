// Web Audio synthesizer for majlis sound effects — no audio files to load.
// Everything routes through one master gain so the settings volume applies.

class SoundFX {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.volume = 0.7;
    this.noise = null;
  }

  init() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return true;
  }

  setVolume(percent) {
    this.volume = Math.max(0, Math.min(1, percent / 100));
    if (this.master) this.master.gain.value = this.volume;
  }

  #ready() {
    return this.enabled && this.volume > 0 && this.init();
  }

  #tone({ type, freq, to, start, dur, peak, attack = 0 }) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, start + dur * 0.8);
    gain.gain.setValueAtTime(attack ? 0 : peak, start);
    if (attack) gain.gain.linearRampToValueAtTime(peak, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
    osc.connect(gain).connect(this.master);
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  // صب القهوة
  playCoffeePour() {
    if (!this.#ready()) return;
    const now = this.ctx.currentTime;
    for (let i = 0; i < 6; i++) {
      const start = now + i * 0.08 + Math.random() * 0.03;
      const freq = 600 + Math.random() * 800 + i * 60;
      this.#tone({ type: 'sine', freq, to: freq + 300, start, dur: 0.08, peak: 0.12 });
    }
  }

  // الترحيب الملكي
  playRoyalChime() {
    if (!this.#ready()) return;
    const now = this.ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      this.#tone({ type: 'triangle', freq, start: now + i * 0.1, dur: 1.2, peak: 0.14, attack: 0.02 });
    });
  }

  // الحماس
  playHype() {
    if (!this.#ready()) return;
    this.#tone({ type: 'sawtooth', freq: 150, to: 880, start: this.ctx.currentTime, dur: 0.4, peak: 0.12, attack: 0.15 });
  }

  // التصفيق — one shared noise buffer instead of allocating per clap
  playApplause() {
    if (!this.#ready()) return;
    if (!this.noise) {
      const size = Math.floor(this.ctx.sampleRate * 0.04);
      this.noise = this.ctx.createBuffer(1, size, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let j = 0; j < size; j++) data[j] = Math.random() * 2 - 1;
    }
    const now = this.ctx.currentTime;
    for (let i = 0; i < 8; i++) {
      const start = now + i * 0.06 + Math.random() * 0.04;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1000 + Math.random() * 600;
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime(0.1, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.04);
      src.connect(filter).connect(gain).connect(this.master);
      src.start(start);
      src.stop(start + 0.05);
    }
  }

  // تنبيه الشات
  playChatNotification() {
    if (!this.#ready()) return;
    const now = this.ctx.currentTime;
    this.#tone({ type: 'sine', freq: 987.77, start: now, dur: 0.07, peak: 0.07 });
    this.#tone({ type: 'sine', freq: 1318.51, start: now + 0.06, dur: 0.14, peak: 0.07 });
  }
}

export const soundFX = new SoundFX();

// Confetti was removed in the calm redesign. No-op kept only until
// ChatPanel (owned by the chat/voice session) drops its import.
export function celebrate() {}
