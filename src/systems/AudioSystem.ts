/**
 * Procedural Web Audio.
 *
 * Every sound here is synthesised at runtime — oscillators, filtered noise,
 * envelopes — because the project has no audio asset pipeline available. That
 * keeps the bundle at zero audio bytes and makes pitch variance free, which
 * matters most for the tap click: at four taps a second, an identical sample
 * would turn into a machine-gun rattle within one interval.
 */

type NoiseKind = 'white' | 'pink';

export class AudioSystem {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambienceGain: GainNode | null = null;
  private duck = 1;
  private muted = false;
  private noiseBuffers = new Map<NoiseKind, AudioBuffer>();
  private ambienceNodes: AudioScheduledSourceNode[] = [];
  private birdTimer: number | null = null;

  constructor(private readonly random: () => number) {}

  /** Must be called from a user gesture; browsers start contexts suspended. */
  unlock(): void {
    if (this.context) {
      if (this.context.state === 'suspended') void this.context.resume();
      return;
    }
    try {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.context = new Ctor();
      this.master = this.context.createGain();
      this.master.gain.value = this.muted ? 0 : 0.8;
      this.master.connect(this.context.destination);
      this.ambienceGain = this.context.createGain();
      this.ambienceGain.gain.value = 0;
      this.ambienceGain.connect(this.master);
      this.startAmbience();
    } catch {
      this.context = null;
    }
  }

  get enabled(): boolean {
    return this.context !== null && !this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 0.8;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Drops everything but the impact while hitstop holds. */
  setDuck(value: number): void {
    this.duck = value;
  }

  private noise(kind: NoiseKind): AudioBuffer | null {
    if (!this.context) return null;
    const cached = this.noiseBuffers.get(kind);
    if (cached) return cached;
    const length = this.context.sampleRate * 2;
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    if (kind === 'white') {
      for (let i = 0; i < length; i += 1) data[i] = this.random() * 2 - 1;
    } else {
      // Paul Kellet's pink noise approximation: warmer, reads as wind/water.
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      for (let i = 0; i < length; i += 1) {
        const white = this.random() * 2 - 1;
        b0 = 0.99765 * b0 + white * 0.099046;
        b1 = 0.963 * b1 + white * 0.2965164;
        b2 = 0.57 * b2 + white * 1.0526913;
        data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.22;
      }
    }
    this.noiseBuffers.set(kind, buffer);
    return buffer;
  }

  private tone(options: {
    frequency: number;
    endFrequency?: number;
    duration: number;
    gain: number;
    type?: OscillatorType;
    delay?: number;
    attack?: number;
  }): void {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime + (options.delay ?? 0);
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = options.type ?? 'sine';
    oscillator.frequency.setValueAtTime(options.frequency, now);
    if (options.endFrequency !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(1, options.endFrequency),
        now + options.duration,
      );
    }
    const attack = options.attack ?? 0.005;
    const peak = options.gain * this.duck;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);
    oscillator.connect(gain).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + options.duration + 0.02);
  }

  private burst(options: {
    kind: NoiseKind;
    duration: number;
    gain: number;
    filterFrom: number;
    filterTo: number;
    q?: number;
    delay?: number;
  }): void {
    if (!this.context || !this.master) return;
    const buffer = this.noise(options.kind);
    if (!buffer) return;
    const now = this.context.currentTime + (options.delay ?? 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = options.q ?? 1;
    filter.frequency.setValueAtTime(options.filterFrom, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, options.filterTo), now + options.duration);
    const gain = this.context.createGain();
    const peak = options.gain * this.duck;
    gain.gain.setValueAtTime(Math.max(0.0002, peak), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);
    source.connect(filter).connect(gain).connect(this.master);
    source.start(now);
    source.stop(now + options.duration + 0.05);
  }

  // ------------------------------------------------------------- ambience

  private startAmbience(): void {
    if (!this.context || !this.ambienceGain) return;
    const buffer = this.noise('pink');
    if (!buffer) return;

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = this.context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 620;
    filter.Q.value = 0.6;
    source.connect(filter).connect(this.ambienceGain);
    source.start();
    this.ambienceNodes.push(source);

    this.ambienceGain.gain.linearRampToValueAtTime(0.055, this.context.currentTime + 2.5);

    // Occasional bird calls keep the jungle from reading as tape hiss.
    const scheduleBird = () => {
      if (!this.context) return;
      const base = 900 + this.random() * 1500;
      const notes = 2 + Math.floor(this.random() * 3);
      for (let i = 0; i < notes; i += 1) {
        this.tone({
          frequency: base * (1 + i * 0.12),
          endFrequency: base * (1 + i * 0.12) * (this.random() > 0.5 ? 1.3 : 0.78),
          duration: 0.12 + this.random() * 0.1,
          gain: 0.025,
          type: 'triangle',
          delay: i * (0.1 + this.random() * 0.08),
        });
      }
      this.birdTimer = window.setTimeout(scheduleBird, 4000 + this.random() * 9000);
    };
    this.birdTimer = window.setTimeout(scheduleBird, 2500);
  }

  // ---------------------------------------------------------------- events

  /** Pitch-varied click, one per accepted tap. */
  tap(intensity: number): void {
    const base = 300 + intensity * 260 + (this.random() - 0.5) * 60;
    this.tone({ frequency: base, endFrequency: base * 0.55, duration: 0.055, gain: 0.13, type: 'square' });
    this.burst({ kind: 'white', duration: 0.035, gain: 0.05, filterFrom: 4200, filterTo: 900 });
  }

  /** Rising two-tone when power enters the target zone. */
  enterZone(): void {
    this.tone({ frequency: 620, duration: 0.09, gain: 0.09, type: 'triangle' });
    this.tone({ frequency: 930, duration: 0.13, gain: 0.075, type: 'triangle', delay: 0.06 });
  }

  leaveZone(): void {
    this.tone({ frequency: 420, endFrequency: 300, duration: 0.11, gain: 0.055, type: 'triangle' });
  }

  countdownTick(final: boolean): void {
    this.tone({
      frequency: final ? 880 : 520,
      duration: final ? 0.24 : 0.1,
      gain: final ? 0.16 : 0.1,
      type: 'square',
    });
  }

  throwWhoosh(): void {
    this.burst({ kind: 'white', duration: 0.34, gain: 0.11, filterFrom: 500, filterTo: 2600, q: 2.4 });
  }

  bounce(): void {
    this.tone({ frequency: 220, endFrequency: 130, duration: 0.12, gain: 0.11, type: 'sine' });
    this.burst({ kind: 'white', duration: 0.08, gain: 0.06, filterFrom: 2600, filterTo: 500 });
  }

  explosion(power: number): void {
    const scale = Math.max(0.6, Math.min(1.8, power));
    this.tone({ frequency: 120 * scale, endFrequency: 34, duration: 0.5 * scale, gain: 0.3, type: 'sine' });
    this.burst({
      kind: 'white',
      duration: 0.45 * scale,
      gain: 0.28,
      filterFrom: 2600 * scale,
      filterTo: 110,
      q: 0.9,
    });
    this.burst({ kind: 'pink', duration: 0.9 * scale, gain: 0.1, filterFrom: 700, filterTo: 90, delay: 0.04 });
  }

  splash(): void {
    this.burst({ kind: 'white', duration: 0.4, gain: 0.18, filterFrom: 900, filterTo: 5200, q: 1.6 });
    this.tone({ frequency: 380, endFrequency: 900, duration: 0.22, gain: 0.07, type: 'sine' });
  }

  hit(): void {
    this.tone({ frequency: 190, endFrequency: 80, duration: 0.18, gain: 0.2, type: 'square' });
    this.burst({ kind: 'white', duration: 0.09, gain: 0.14, filterFrom: 3200, filterTo: 400 });
  }

  perfect(): void {
    const notes = [784, 988, 1319];
    notes.forEach((frequency, index) => {
      this.tone({ frequency, duration: 0.34, gain: 0.11, type: 'triangle', delay: index * 0.075 });
    });
  }

  eliminate(): void {
    this.tone({ frequency: 440, endFrequency: 110, duration: 0.7, gain: 0.18, type: 'sawtooth' });
    const fanfare = [523, 659, 784, 1047];
    fanfare.forEach((frequency, index) => {
      this.tone({ frequency, duration: 0.28, gain: 0.1, type: 'square', delay: 0.3 + index * 0.09 });
    });
  }

  uiClick(): void {
    this.tone({ frequency: 660, endFrequency: 880, duration: 0.06, gain: 0.08, type: 'square' });
  }

  uiConfirm(): void {
    this.tone({ frequency: 523, duration: 0.1, gain: 0.1, type: 'triangle' });
    this.tone({ frequency: 784, duration: 0.16, gain: 0.09, type: 'triangle', delay: 0.07 });
  }

  victory(): void {
    const melody = [523, 659, 784, 1047, 784, 1047, 1319];
    melody.forEach((frequency, index) => {
      this.tone({ frequency, duration: 0.36, gain: 0.11, type: 'triangle', delay: index * 0.14 });
    });
  }

  dispose(): void {
    if (this.birdTimer !== null) window.clearTimeout(this.birdTimer);
    for (const node of this.ambienceNodes) {
      try {
        node.stop();
      } catch {
        // Already stopped.
      }
    }
    this.ambienceNodes = [];
    void this.context?.close();
    this.context = null;
  }
}
