import { ANIMALS, getAnimal } from '../game/roster';
import { MATCH } from '../game/config';
import { animalIcon } from './icons';
import type { PlayerConfig, PlayerStats } from '../game/types';

/**
 * Setup, pause and results screens.
 *
 * The setup screen is the only place with real information density, so it gets
 * the design-system panel treatment. Pause and results are deliberately thin:
 * primary action first, everything else secondary, no marketing layout inside a
 * game.
 */

function must<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error('Missing UI element: ' + selector);
  return element;
}

export type ResultRow = {
  slot: number;
  animalId: string;
  name: string;
  controller: 'human' | 'ai';
  health: number;
  stats: PlayerStats;
  winner: boolean;
};

export class SetupScreen {
  private readonly root = must('#setup-screen');
  private readonly slotList = must('#slot-list');
  private readonly animalGrid = must('#animal-grid');
  private readonly animalDetail = must('#animal-detail');
  private readonly rosterFor = must('#roster-for');
  private readonly addButton = must<HTMLButtonElement>('#add-slot');
  private readonly removeButton = must<HTMLButtonElement>('#remove-slot');
  private readonly startButton = must<HTMLButtonElement>('#start-match');
  private readonly windToggle = must<HTMLInputElement>('#wind-toggle');
  private readonly modelsToggle = must<HTMLInputElement>('#models-toggle');
  private readonly portraitName = must('#portrait-name');
  private readonly portraitSpecies = must('#portrait-species');

  private players: PlayerConfig[] = [];
  private selectedSlot = 0;

  onStart:
    | ((players: PlayerConfig[], wind: boolean, generatedModels: boolean) => void)
    | null = null;
  onInteract: (() => void) | null = null;
  /** Fired whenever the previewed fighter changes. */
  onPreview: ((animalId: string) => void) | null = null;

  constructor() {
    this.addButton.addEventListener('click', () => {
      this.onInteract?.();
      if (this.players.length >= MATCH.maxPlayers) return;
      const taken = new Set(this.players.map((player) => player.animalId));
      const free = ANIMALS.find((animal) => !taken.has(animal.id)) ?? ANIMALS[0];
      this.players.push({
        slot: this.players.length,
        controller: 'ai',
        animalId: free.id,
        aiSkill: 0.62,
      });
      this.selectedSlot = this.players.length - 1;
      this.render();
    });

    this.removeButton.addEventListener('click', () => {
      this.onInteract?.();
      if (this.players.length <= MATCH.minPlayers + 1) return;
      this.players.pop();
      this.selectedSlot = Math.min(this.selectedSlot, this.players.length - 1);
      this.render();
    });

    this.startButton.addEventListener('click', () => {
      this.onStart?.(
        this.players.map((player) => ({ ...player })),
        this.windToggle.checked,
        this.modelsToggle.checked,
      );
    });

    this.windToggle.addEventListener('change', () => this.onInteract?.());
    this.modelsToggle.addEventListener('change', () => this.onInteract?.());
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  /** Start button doubles as the progress readout while a cast downloads. */
  setBusy(busy: boolean, label?: string): void {
    this.startButton.disabled = busy;
    this.startButton.textContent = busy ? (label ?? 'Loading…') : 'Start match';
  }

  get isVisible(): boolean {
    return !this.root.hidden;
  }

  /** Default line-up: one human, one bot — playable solo without touching setup. */
  initialise(players?: PlayerConfig[]): void {
    this.players = players?.map((player) => ({ ...player })) ?? [
      { slot: 0, controller: 'human', animalId: 'gecko', aiSkill: 0.62 },
      { slot: 1, controller: 'ai', animalId: 'boar', aiSkill: 0.62 },
    ];
    this.selectedSlot = 0;
    this.render();
  }

  private render(): void {
    this.players.forEach((player, index) => {
      player.slot = index;
    });

    // --- slot list ---
    this.slotList.replaceChildren();
    this.players.forEach((player, index) => {
      const animal = getAnimal(player.animalId);
      const row = document.createElement('div');
      row.className = 'slot' + (index === this.selectedSlot ? ' slot--selected' : '');
      row.style.setProperty('--slot-color', '#' + animal.palette.accent.toString(16).padStart(6, '0'));
      row.innerHTML =
        '<div class="slot__icon">' +
        animalIcon(animal.id, 36) +
        '</div>' +
        '<div class="slot__text">' +
        '<span class="slot__player">Player ' +
        (index + 1) +
        '</span>' +
        '<span class="slot__name">' +
        animal.name +
        ' the ' +
        animal.species +
        '</span>' +
        '</div>';

      const control = document.createElement('button');
      control.type = 'button';
      control.className = 'slot__control';
      control.dataset.kind = player.controller;
      control.textContent = player.controller === 'human' ? 'Human' : 'AI';
      control.setAttribute('aria-label', 'Player ' + (index + 1) + ' is ' + control.textContent + ', click to switch');
      control.addEventListener('click', (event) => {
        event.stopPropagation();
        this.onInteract?.();
        player.controller = player.controller === 'human' ? 'ai' : 'human';
        this.render();
      });
      row.append(control);

      row.addEventListener('click', () => {
        this.onInteract?.();
        this.selectedSlot = index;
        this.render();
      });
      this.slotList.append(row);
    });

    this.addButton.disabled = this.players.length >= MATCH.maxPlayers;
    this.removeButton.disabled = this.players.length <= MATCH.minPlayers + 1;

    // --- animal picker ---
    const active = this.players[this.selectedSlot];
    this.rosterFor.textContent = 'Player ' + (this.selectedSlot + 1);
    this.animalGrid.replaceChildren();

    for (const animal of ANIMALS) {
      const takenBy = this.players.findIndex((player) => player.animalId === animal.id);
      const isMine = takenBy === this.selectedSlot;
      const taken = takenBy >= 0 && !isMine;

      const card = document.createElement('button');
      card.type = 'button';
      card.className =
        'animal-card' + (isMine ? ' animal-card--active' : '') + (taken ? ' animal-card--taken' : '');
      card.disabled = taken;
      card.innerHTML =
        animalIcon(animal.id, 46) +
        '<span class="animal-card__name">' +
        animal.name +
        '</span>' +
        '<span class="animal-card__species">' +
        animal.species +
        '</span>';
      card.addEventListener('click', () => {
        this.onInteract?.();
        active.animalId = animal.id;
        this.render();
      });
      card.addEventListener('mouseenter', () => this.showDetail(animal.id));
      card.addEventListener('focus', () => this.showDetail(animal.id));
      this.animalGrid.append(card);
    }

    this.showDetail(active.animalId);
  }

  private showDetail(animalId: string): void {
    const animal = getAnimal(animalId);
    this.animalDetail.innerHTML =
      '<strong>' + animal.name + ' the ' + animal.species + '</strong> &mdash; ' + animal.perkLabel;
    this.portraitName.textContent = animal.name;
    this.portraitSpecies.textContent = animal.species;
    this.onPreview?.(animal.id);
  }
}

export class PauseScreen {
  private readonly root = must('#pause-screen');

  onResume: (() => void) | null = null;
  onRestart: (() => void) | null = null;
  onQuit: (() => void) | null = null;

  constructor() {
    must<HTMLButtonElement>('#resume-button').addEventListener('click', () => this.onResume?.());
    must<HTMLButtonElement>('#restart-button').addEventListener('click', () => this.onRestart?.());
    must<HTMLButtonElement>('#quit-button').addEventListener('click', () => this.onQuit?.());
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  get isVisible(): boolean {
    return !this.root.hidden;
  }
}

export class ResultsScreen {
  private readonly root = must('#results-screen');
  private readonly eyebrow = must('#results-eyebrow');
  private readonly title = must('#results-title');
  private readonly table = must('#results-table');

  onRematch: (() => void) | null = null;
  onSetup: (() => void) | null = null;

  constructor() {
    must<HTMLButtonElement>('#rematch-button').addEventListener('click', () => this.onRematch?.());
    must<HTMLButtonElement>('#results-setup-button').addEventListener('click', () => this.onSetup?.());
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  get isVisible(): boolean {
    return !this.root.hidden;
  }

  /**
   * Damage dealt is the headline, but average interval accuracy sits right
   * next to it — that is the number that transfers to a trainer, and the one
   * players will want to chase between matches.
   */
  show(rows: ResultRow[], reason: string): void {
    const sorted = [...rows].sort((a, b) => {
      if (a.winner !== b.winner) return a.winner ? -1 : 1;
      return b.stats.damageDealt - a.stats.damageDealt;
    });

    const champion = sorted.find((row) => row.winner) ?? sorted[0];
    this.eyebrow.textContent = reason;
    this.title.textContent = champion
      ? champion.name + ' the ' + getAnimal(champion.animalId).species + ' takes it'
      : 'Nobody survived';

    this.table.replaceChildren();

    const head = document.createElement('div');
    head.className = 'results__head';
    head.innerHTML =
      '<span></span><span>Fighter</span><span style="text-align:right">Damage</span>' +
      '<span style="text-align:right">Avg acc</span>' +
      '<span style="text-align:right" class="results__hide-narrow">Best</span>' +
      '<span style="text-align:right" class="results__hide-narrow">In zone</span>';
    this.table.append(head);

    for (const row of sorted) {
      const animal = getAnimal(row.animalId);
      const shots = Math.max(1, row.stats.shotsFired);
      const averageAccuracy = row.stats.accuracySum / shots;
      const node = document.createElement('div');
      node.className = 'results__row' + (row.winner ? ' results__row--winner' : '');
      node.style.setProperty('--row-color', '#' + animal.palette.accent.toString(16).padStart(6, '0'));
      node.innerHTML =
        '<span class="results__icon">' +
        animalIcon(animal.id, 30) +
        '</span>' +
        '<span class="results__name"><b>' +
        row.name +
        '</b><span>' +
        animal.species +
        (row.controller === 'ai' ? ' · AI' : '') +
        ' · ' +
        Math.ceil(row.health) +
        ' HP</span></span>' +
        '<span class="results__num results__num--accent">' +
        Math.round(row.stats.damageDealt) +
        '</span>' +
        '<span class="results__num">' +
        Math.round(averageAccuracy * 100) +
        '%</span>' +
        '<span class="results__num results__num--muted results__hide-narrow">' +
        Math.round(row.stats.bestAccuracy * 100) +
        '%</span>' +
        '<span class="results__num results__num--muted results__hide-narrow">' +
        row.stats.secondsInZone.toFixed(1) +
        's</span>';
      this.table.append(node);
    }
  }
}
