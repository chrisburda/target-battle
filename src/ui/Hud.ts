import * as THREE from 'three';
import { AMMO } from '../game/roster';
import { POWER } from '../game/config';
import { animalIcon, ammoIcon, ICON_PAUSE, ICON_SOUND_OFF, ICON_SOUND_ON } from './icons';
import type { AmmoDef, AnimalDef } from '../game/types';
import type { IntervalPlan } from '../game/IntervalScorer';

/**
 * In-game HUD.
 *
 * Everything is written from game state each frame; the HUD owns no rules. The
 * two docks (aim, interval) are mutually exclusive and both live at the bottom
 * centre, well clear of the arc the projectile travels through — a panel over
 * the flight path would hide the one thing the player is watching.
 */

/** One selectable opponent in the target picker. */
export type TargetCard = {
  slot: number;
  animal: AnimalDef;
  health: number;
  maxHealth: number;
  /** Horizontal gap in world units. */
  distance: number;
  /** Solved launch angle, shown as information only. */
  angle: number;
  /** Whether a perfect interval lands on them, near them, or not at all. */
  quality: 'clear' | 'splash' | 'blocked';
};

export type RosterEntry = {
  slot: number;
  animal: AnimalDef;
  name: string;
  controller: 'human' | 'ai';
  health: number;
  maxHealth: number;
  damageDealt: number;
  accuracy: number;
  alive: boolean;
  active: boolean;
};

type Elements = {
  hud: HTMLElement;
  rosterRail: HTMLElement;
  roundLabel: HTMLElement;
  windGauge: HTMLElement;
  eventBanner: HTMLElement;
  aimPanel: HTMLElement;
  targetStrip: HTMLElement;
  lineReadout: HTMLElement;
  ammoStrip: HTMLElement;
  ammoBlurb: HTMLElement;
  intervalPanel: HTMLElement;
  targetWatts: HTMLElement;
  zoneFlag: HTMLElement;
  intervalClock: HTMLElement;
  meterZone: HTMLElement;
  meterFill: HTMLElement;
  meterTarget: HTMLElement;
  meterNeedle: HTMLElement;
  meterWatts: HTMLElement;
  meterScale: HTMLElement;
  liveAccuracy: HTMLElement;
  liveCadence: HTMLElement;
  intervalProgress: HTMLElement;
  countdown: HTMLElement;
  countdownValue: HTMLElement;
  floaters: HTMLElement;
  soundButton: HTMLButtonElement;
  pauseButton: HTMLButtonElement;
  touch: HTMLElement;
  touchNext: HTMLButtonElement;
  touchPrev: HTMLButtonElement;
  touchAction: HTMLButtonElement;
};

/** Short badge on each card. */
const LINE_LABEL: Record<'clear' | 'splash' | 'blocked', string> = {
  clear: 'CLEAR',
  splash: 'GRAZE',
  blocked: 'BLOCKED',
};

/**
 * Readout above the picker. Two or three words: the badge on each card already
 * carries the state, so a full sentence here was the same information twice.
 */
const LINE_DETAIL: Record<'clear' | 'splash' | 'blocked', string> = {
  clear: 'Clear line',
  splash: 'Graze only',
  blocked: 'No line',
};

function must<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error('Missing UI element: ' + selector);
  return element;
}

export class Hud {
  private readonly el: Elements;
  private readonly chipCache = new Map<number, HTMLElement>();
  private readonly projected = new THREE.Vector3();
  private bannerTimer: number | null = null;
  private lastCountdown = '';
  private ammoSlots: HTMLButtonElement[] = [];
  private renderedAmmoKey = '';
  private renderedTargetKey = '';

  /** Emitted so Game owns every rule; the HUD only reports intent. */
  onAmmoPicked: ((ammoId: string) => void) | null = null;
  onTargetPicked: ((slot: number) => void) | null = null;
  onPause: (() => void) | null = null;
  onToggleSound: (() => void) | null = null;
  onTouchAim: ((direction: -1 | 0 | 1) => void) | null = null;
  onTouchAction: (() => void) | null = null;

  constructor() {
    this.el = {
      hud: must('#hud'),
      rosterRail: must('#roster-rail'),
      roundLabel: must('#round-label'),
      windGauge: must('#wind-gauge'),
      eventBanner: must('#event-banner'),
      aimPanel: must('#aim-panel'),
      targetStrip: must('#target-strip'),
      lineReadout: must('#line-readout'),
      ammoStrip: must('#ammo-strip'),
      ammoBlurb: must('#ammo-blurb'),
      intervalPanel: must('#interval-panel'),
      targetWatts: must('#target-watts'),
      zoneFlag: must('#zone-flag'),
      intervalClock: must('#interval-clock'),
      meterZone: must('#meter-zone'),
      meterFill: must('#meter-fill'),
      meterTarget: must('#meter-target'),
      meterNeedle: must('#meter-needle'),
      meterWatts: must('#meter-watts'),
      meterScale: must('#meter-scale'),
      liveAccuracy: must('#live-accuracy'),
      liveCadence: must('#live-cadence'),
      intervalProgress: must('#interval-progress'),
      countdown: must('#countdown'),
      countdownValue: must('#countdown-value'),
      floaters: must('#floaters'),
      soundButton: must('#sound-button'),
      pauseButton: must('#pause-button'),
      touch: must('#touch-controls'),
      touchNext: must('#touch-next'),
      touchPrev: must('#touch-prev'),
      touchAction: must('#touch-action'),
    };

    this.el.pauseButton.innerHTML = ICON_PAUSE;
    this.el.soundButton.innerHTML = ICON_SOUND_ON;
    this.el.pauseButton.addEventListener('click', () => this.onPause?.());
    this.el.soundButton.addEventListener('click', () => this.onToggleSound?.());

    // Touch aim uses press-and-hold, so it must release on cancel and leave too.
    const bindHold = (button: HTMLButtonElement, direction: -1 | 1) => {
      const press = (event: PointerEvent) => {
        event.preventDefault();
        this.onTouchAim?.(direction);
      };
      const release = (event: PointerEvent) => {
        event.preventDefault();
        this.onTouchAim?.(0);
      };
      button.addEventListener('pointerdown', press);
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('pointerleave', release);
    };
    bindHold(this.el.touchNext, 1);
    bindHold(this.el.touchPrev, -1);
    this.el.touchAction.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.onTouchAction?.();
    });
  }

  setVisible(visible: boolean): void {
    this.el.hud.hidden = !visible;
  }

  setTouchVisible(visible: boolean): void {
    this.el.touch.hidden = !visible;
  }

  setTouchActionLabel(label: string): void {
    this.el.touchAction.textContent = label;
  }

  setSoundMuted(muted: boolean): void {
    this.el.soundButton.innerHTML = muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
    this.el.soundButton.setAttribute('aria-pressed', String(muted));
  }

  // -------------------------------------------------------------- roster

  buildRoster(entries: RosterEntry[]): void {
    this.el.rosterRail.replaceChildren();
    this.chipCache.clear();

    for (const entry of entries) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.style.setProperty('--chip-color', '#' + entry.animal.palette.accent.toString(16).padStart(6, '0'));
      chip.innerHTML =
        '<div class="chip__icon">' +
        animalIcon(entry.animal.id, 28) +
        '</div>' +
        '<div class="chip__body">' +
        '<div class="chip__row">' +
        '<span class="chip__name"></span>' +
        '<span class="chip__hp"></span>' +
        '</div>' +
        '<div class="chip__bar"><div class="chip__bar-fill"></div></div>' +
        '<div class="chip__meta"><span>DMG <b class="chip__dmg">0</b></span><span>ACC <b class="chip__acc">--</b></span></div>' +
        '</div>';
      this.el.rosterRail.append(chip);
      this.chipCache.set(entry.slot, chip);
    }
    this.updateRoster(entries);
  }

  updateRoster(entries: RosterEntry[]): void {
    for (const entry of entries) {
      const chip = this.chipCache.get(entry.slot);
      if (!chip) continue;
      chip.classList.toggle('chip--active', entry.active);
      chip.classList.toggle('chip--out', !entry.alive);

      const name = chip.querySelector('.chip__name');
      if (name) {
        name.textContent = entry.name + (entry.controller === 'ai' ? ' · AI' : '');
      }
      const hp = chip.querySelector('.chip__hp');
      if (hp) hp.textContent = String(Math.ceil(entry.health));

      const fill = chip.querySelector<HTMLElement>('.chip__bar-fill');
      if (fill) {
        const ratio = Math.max(0, entry.health / entry.maxHealth);
        fill.style.width = (ratio * 100).toFixed(1) + '%';
        fill.style.background =
          ratio > 0.55 ? 'var(--green)' : ratio > 0.25 ? 'var(--yellow)' : 'var(--red)';
      }
      const dmg = chip.querySelector('.chip__dmg');
      if (dmg) dmg.textContent = String(Math.round(entry.damageDealt));
      const acc = chip.querySelector('.chip__acc');
      if (acc) acc.textContent = entry.accuracy > 0 ? Math.round(entry.accuracy * 100) + '%' : '--';
    }
  }

  setRound(round: number, maxRounds: number): void {
    this.el.roundLabel.textContent = 'Round ' + round + ' / ' + maxRounds;
  }

  /**
   * Wind is shown as chevrons plus a direction word. Direction is carried by
   * both the glyph and the text so it does not depend on colour alone.
   */
  setWind(wind: number, maxWind: number): void {
    const magnitude = Math.abs(wind);
    const steps = Math.min(4, Math.round((magnitude / maxWind) * 4));
    if (steps === 0) {
      this.el.windGauge.innerHTML =
        '<span class="wind-gauge__arrows wind-gauge__arrows--calm">&mdash;</span><span>Calm</span>';
      return;
    }
    const glyph = wind > 0 ? '❯' : '❮';
    const arrows = new Array(steps).fill(glyph).join('');
    const label = wind > 0 ? 'Wind right' : 'Wind left';
    this.el.windGauge.innerHTML =
      '<span class="wind-gauge__arrows">' +
      arrows +
      '</span><span>' +
      label +
      '</span>';
  }

  // --------------------------------------------------------------- docks

  showAimDock(visible: boolean): void {
    this.el.aimPanel.hidden = !visible;
    // Force a rebuild next turn: the same cards can recur with a different
    // active fighter, and the cache key does not know whose turn it is.
    if (!visible) this.renderedTargetKey = '';
    this.syncDockHeight();
  }

  showIntervalDock(visible: boolean): void {
    this.el.intervalPanel.hidden = !visible;
    this.syncDockHeight();
  }

  /**
   * Publishes the visible dock's height as a CSS variable so the touch row can
   * sit exactly above it. The aim dock and the interval meter are different
   * heights, and a hard-coded offset put the thumb buttons across the power
   * meter on a phone — over the one number the player is chasing.
   */
  private syncDockHeight(): void {
    // Measure on the next frame: the dock has just been unhidden.
    requestAnimationFrame(() => {
      const visible = !this.el.intervalPanel.hidden
        ? this.el.intervalPanel
        : !this.el.aimPanel.hidden
          ? this.el.aimPanel
          : null;
      const height = visible ? Math.ceil(visible.getBoundingClientRect().height) : 0;
      document.documentElement.style.setProperty('--dock-height', height + 'px');
    });
  }

  /**
   * Renders the target picker.
   *
   * There is no angle control, so this list is the player's only spatial
   * decision. Each card carries the range and the state of the line, because
   * "can I actually reach them" is exactly the question the choice turns on —
   * and the line state is written as a word as well as a colour.
   */
  setTargets(cards: TargetCard[], selectedSlot: number): void {
    const key = selectedSlot + '|' + cards
      .map((c) => c.slot + ':' + Math.round(c.health) + ':' + c.quality + ':' + Math.round(c.distance))
      .join(',');
    if (key === this.renderedTargetKey) return;
    this.renderedTargetKey = key;

    this.el.targetStrip.replaceChildren();

    for (const card of cards) {
      const chosen = card.slot === selectedSlot;
      const button = document.createElement('button');
      button.type = 'button';
      button.className =
        'target-card' +
        (chosen ? ' target-card--chosen' : '') +
        ' target-card--' + card.quality;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(chosen));
      button.setAttribute(
        'aria-label',
        card.animal.name + ', ' + Math.ceil(card.health) + ' health, ' +
          Math.round(card.distance) + ' metres, line ' + card.quality,
      );
      button.style.setProperty(
        '--card-color',
        '#' + card.animal.palette.accent.toString(16).padStart(6, '0'),
      );

      const ratio = Math.max(0, card.health / card.maxHealth);
      button.innerHTML =
        '<span class="target-card__icon">' + animalIcon(card.animal.id, 30) + '</span>' +
        '<span class="target-card__body">' +
        '<span class="target-card__name">' + card.animal.name + '</span>' +
        '<span class="target-card__bar"><span class="target-card__bar-fill" style="width:' +
        (ratio * 100).toFixed(0) + '%"></span></span>' +
        '<span class="target-card__meta">' + Math.round(card.distance) + 'm · ' +
        Math.round(card.angle) + '°</span>' +
        '</span>' +
        '<span class="target-card__line">' + LINE_LABEL[card.quality] + '</span>';

      button.addEventListener('click', () => this.onTargetPicked?.(card.slot));
      this.el.targetStrip.append(button);
    }

    const selected = cards.find((card) => card.slot === selectedSlot);
    this.el.lineReadout.className = 'line-readout' + (selected ? ' line-readout--' + selected.quality : '');
    this.el.lineReadout.textContent = selected ? LINE_DETAIL[selected.quality] : 'No target';
  }

  /** Rebuilds the ammo strip only when the inventory actually changed. */
  setAmmo(inventory: Map<string, number>, selectedId: string): void {
    const key =
      selectedId + '|' + AMMO.map((ammo) => inventory.get(ammo.id) ?? 0).join(',');
    if (key === this.renderedAmmoKey) return;
    this.renderedAmmoKey = key;

    this.el.ammoStrip.replaceChildren();
    this.ammoSlots = [];

    AMMO.forEach((ammo, index) => {
      const remaining = inventory.get(ammo.id) ?? 0;
      const unlimited = remaining < 0;
      const usable = unlimited || remaining > 0;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ammo-slot' + (ammo.id === selectedId ? ' ammo-slot--active' : '');
      button.disabled = !usable;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(ammo.id === selectedId));
      button.setAttribute('aria-label', ammo.name + (unlimited ? ', unlimited' : ', ' + remaining + ' left'));
      button.innerHTML =
        '<span class="ammo-slot__key">' +
        (index + 1) +
        '</span>' +
        ammoIcon(ammo.id, 24) +
        '<span class="ammo-slot__count">' +
        (unlimited ? '∞' : String(remaining)) +
        '</span>';
      button.addEventListener('click', () => this.onAmmoPicked?.(ammo.id));
      this.el.ammoStrip.append(button);
      this.ammoSlots.push(button);
    });
  }

  setAmmoBlurb(ammo: AmmoDef): void {
    this.el.ammoBlurb.innerHTML =
      '<strong>' + ammo.name + '</strong> &mdash; ' + ammo.blurb;
  }

  // -------------------------------------------------------------- meter

  /** Called once when the interval opens, to lay out the fixed elements. */
  primeMeter(plan: IntervalPlan): void {
    const max = plan.targetWatts * POWER.meterHeadroom;
    this.el.targetWatts.textContent = String(Math.round(plan.targetWatts));
    this.el.meterScale.replaceChildren();
    const ticks = [0, plan.targetWatts * 0.5, plan.targetWatts, max];
    for (const tick of ticks) {
      const span = document.createElement('span');
      span.textContent = Math.round(tick) + 'W';
      this.el.meterScale.append(span);
    }
    this.el.liveAccuracy.textContent = '0';
    this.el.liveCadence.textContent = '0.0';
    this.el.intervalProgress.style.width = '0%';
  }

  /**
   * Per-frame meter write. `zoneState` drives both the flag text and the fill
   * colour, so the "are you on target" read has a shape channel and a colour
   * channel rather than colour alone.
   */
  updateMeter(state: {
    watts: number;
    displayWatts: number;
    target: number;
    zone: number;
    meterMax: number;
    remaining: number;
    progress: number;
    accuracy: number;
    cadence: number;
    zoneState: 'low' | 'in' | 'high';
    grace: boolean;
  }): void {
    const clampPercent = (value: number) => Math.max(0, Math.min(100, value));
    const toPercent = (watts: number) => clampPercent((watts / state.meterMax) * 100);

    const zoneLeft = toPercent(state.target * (1 - state.zone));
    const zoneRight = toPercent(state.target * (1 + state.zone));
    this.el.meterZone.style.left = zoneLeft + '%';
    this.el.meterZone.style.width = Math.max(0.5, zoneRight - zoneLeft) + '%';
    this.el.meterTarget.style.left = toPercent(state.target) + '%';

    const needlePercent = toPercent(state.displayWatts);
    this.el.meterFill.style.width = needlePercent + '%';
    this.el.meterNeedle.style.left = needlePercent + '%';
    this.el.meterNeedle.classList.toggle('meter__needle--flip', needlePercent > 68);
    this.el.meterWatts.textContent = Math.round(state.displayWatts) + ' W';
    this.el.meterFill.classList.toggle('meter__fill--in', state.zoneState === 'in');

    this.el.zoneFlag.classList.remove('zone-flag--in', 'zone-flag--low', 'zone-flag--high');
    if (state.grace) {
      this.el.zoneFlag.textContent = 'Spin up';
    } else if (state.zoneState === 'in') {
      this.el.zoneFlag.textContent = 'On target';
      this.el.zoneFlag.classList.add('zone-flag--in');
    } else if (state.zoneState === 'low') {
      this.el.zoneFlag.textContent = 'Push harder';
      this.el.zoneFlag.classList.add('zone-flag--low');
    } else {
      this.el.zoneFlag.textContent = 'Ease off';
      this.el.zoneFlag.classList.add('zone-flag--high');
    }

    this.el.intervalClock.textContent = state.remaining.toFixed(1);
    this.el.intervalProgress.style.width = clampPercent(state.progress * 100) + '%';
    this.el.liveAccuracy.textContent = String(Math.round(state.accuracy * 100));
    this.el.liveCadence.textContent = state.cadence.toFixed(1);
  }

  // ------------------------------------------------------------- moments

  showBanner(text: string, tone: 'neutral' | 'good' | 'big' = 'neutral', durationMs = 1500): void {
    this.el.eventBanner.textContent = text;
    this.el.eventBanner.classList.remove('event-banner--good', 'event-banner--big');
    if (tone === 'good') this.el.eventBanner.classList.add('event-banner--good');
    if (tone === 'big') this.el.eventBanner.classList.add('event-banner--big');
    this.el.eventBanner.classList.add('event-banner--show');
    if (this.bannerTimer !== null) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => {
      this.el.eventBanner.classList.remove('event-banner--show');
      this.bannerTimer = null;
    }, durationMs);
  }

  hideBanner(): void {
    if (this.bannerTimer !== null) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = null;
    this.el.eventBanner.classList.remove('event-banner--show');
  }

  setCountdown(value: string | null): void {
    if (value === null) {
      this.el.countdown.hidden = true;
      this.lastCountdown = '';
      return;
    }
    this.el.countdown.hidden = false;
    if (value !== this.lastCountdown) {
      this.lastCountdown = value;
      this.el.countdownValue.textContent = value;
      this.el.countdown.classList.remove('countdown--pop');
      // Force a reflow so the animation restarts on every new number.
      void this.el.countdown.offsetWidth;
      this.el.countdown.classList.add('countdown--pop');
    }
  }

  /** World-anchored floating number. Projected once at spawn, then CSS-animated. */
  floater(
    worldPosition: THREE.Vector3,
    camera: THREE.Camera,
    text: string,
    variant: 'normal' | 'crit' | 'miss' | 'heal' = 'normal',
  ): void {
    this.projected.copy(worldPosition).project(camera);
    if (this.projected.z > 1) return;
    const rect = this.el.floaters.getBoundingClientRect();
    const x = (this.projected.x * 0.5 + 0.5) * rect.width;
    const y = (-this.projected.y * 0.5 + 0.5) * rect.height;

    const node = document.createElement('div');
    node.className = 'floater' + (variant === 'normal' ? '' : ' floater--' + variant);
    node.textContent = text;
    node.style.left = Math.max(24, Math.min(rect.width - 24, x)) + 'px';
    node.style.top = Math.max(24, Math.min(rect.height - 24, y)) + 'px';
    this.el.floaters.append(node);
    window.setTimeout(() => node.remove(), 1200);
  }

  clearFloaters(): void {
    this.el.floaters.replaceChildren();
  }
}
