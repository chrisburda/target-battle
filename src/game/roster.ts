import type { AmmoDef, AnimalDef } from './types';

/**
 * Six fighters. Every perk is deliberately tied to the power interval or the
 * shot it produces, so picking an animal is a statement about how you expect to
 * ride: steady holders take the Gecko, sprinters who overshoot take the Boar.
 */
export const ANIMALS: AnimalDef[] = [
  {
    id: 'gecko',
    name: 'Pip',
    species: 'Gecko',
    perkLabel: 'Steady Grip — 25% less aim wobble',
    perk: { wobble: 0.75, damage: 1, armor: 1, launch: 1, blast: 1, wind: 1, zoneBonus: 0 },
    palette: { body: 0x7ac832, belly: 0xd8ef9a, accent: 0xf5a623, limb: 0x5fa521, eye: 0xfff3c4, cloth: 0xf2b134, leather: 0x6b4a2c },
  },
  {
    id: 'frog',
    name: 'Bruno',
    species: 'Tree Frog',
    perkLabel: 'Big Splash — 20% wider blast radius',
    perk: { wobble: 1, damage: 1, armor: 1, launch: 1, blast: 1.2, wind: 1, zoneBonus: 0 },
    palette: { body: 0x27b2c4, belly: 0xc9f2ef, accent: 0xf25f5c, limb: 0x1d8b9a, eye: 0xffe066, cloth: 0xe8574a, leather: 0x4a3524 },
  },
  {
    id: 'boar',
    name: 'Tusk',
    species: 'Wild Boar',
    perkLabel: 'Heavy Hitter — +15% damage, +15% wobble',
    perk: { wobble: 1.15, damage: 1.15, armor: 1, launch: 1, blast: 1, wind: 1, zoneBonus: 0 },
    palette: { body: 0x8a5a3b, belly: 0xc79b73, accent: 0xf2e8d5, limb: 0x6d452c, eye: 0xffd166, cloth: 0x3d6ea8, leather: 0x5a3a22 },
  },
  {
    id: 'raccoon',
    name: 'Sly',
    species: 'Raccoon',
    perkLabel: 'Good Enough — wider target zone',
    perk: { wobble: 1, damage: 1, armor: 1, launch: 1, blast: 1, wind: 1, zoneBonus: 0.022 },
    palette: { body: 0x8d949e, belly: 0xdfe4ea, accent: 0x2f353d, limb: 0x6f767f, eye: 0xffe9a8, cloth: 0x2f7d6b, leather: 0x45362a },
  },
  {
    id: 'tortoise',
    name: 'Bunker',
    species: 'Tortoise',
    perkLabel: 'Shell Up — 20% less damage taken, slower throws',
    perk: { wobble: 1, damage: 1, armor: 0.8, launch: 0.94, blast: 1, wind: 1, zoneBonus: 0 },
    palette: { body: 0x9aa552, belly: 0xd7d9a8, accent: 0x6b4f28, limb: 0x7d8744, eye: 0xfff0c9, cloth: 0xd8483c, leather: 0x5c4630 },
  },
  {
    id: 'toucan',
    name: 'Zip',
    species: 'Toucan',
    perkLabel: 'Wind Reader — wind affects your shots half as much',
    perk: { wobble: 1, damage: 1, armor: 1, launch: 1, blast: 1, wind: 0.5, zoneBonus: 0 },
    palette: { body: 0x35323a, belly: 0xfdf3dc, accent: 0xff8b1f, limb: 0x24222a, eye: 0xfff6e0, cloth: 0xf4f0e4, leather: 0x45362a },
  },
];

export function getAnimal(id: string): AnimalDef {
  return ANIMALS.find((animal) => animal.id === id) ?? ANIMALS[0];
}

/**
 * Ammo is the turn's tactical choice. Rocks are unlimited so a bad interval is
 * never unrecoverable; the specials are scarce enough that spending one on a
 * shot you are not confident in stings.
 */
export const AMMO: AmmoDef[] = [
  {
    id: 'rock',
    name: 'River Rock',
    rounds: -1,
    damage: 26,
    radius: 5.6,
    behaviour: 'impact',
    launch: 1,
    bounces: 0,
    fragments: 0,
    blurb: 'Unlimited.',
    color: 0x8d8577,
    accent: 0x5f594e,
  },
  {
    id: 'coconut',
    name: 'Coconut',
    rounds: 3,
    damage: 22,
    radius: 5.1,
    behaviour: 'bounce',
    launch: 1.04,
    bounces: 2,
    fragments: 0,
    blurb: 'Bounces twice off the ground.',
    color: 0x7a4a26,
    accent: 0xc79b73,
  },
  {
    id: 'melon',
    name: 'War Melon',
    rounds: 2,
    damage: 38,
    radius: 8.4,
    behaviour: 'impact',
    launch: 0.85,
    bounces: 0,
    fragments: 0,
    blurb: 'Heavy. Short range, huge crater.',
    color: 0x3f7d2a,
    accent: 0xe8574a,
  },
  {
    id: 'cluster',
    name: 'Pine Cluster',
    rounds: 2,
    damage: 15,
    radius: 4.1,
    behaviour: 'cluster',
    launch: 1.02,
    bounces: 0,
    fragments: 3,
    blurb: 'Splits into three at the top of its arc.',
    color: 0x6a4a2b,
    accent: 0xa87a45,
  },
  {
    id: 'hive',
    name: 'Angry Hive',
    rounds: 1,
    damage: 12,
    radius: 5.8,
    behaviour: 'swarm',
    launch: 0.98,
    bounces: 0,
    fragments: 0,
    blurb: 'Light hit, then a swarm that keeps stinging.',
    color: 0xc98a2b,
    accent: 0xffd166,
  },
];

export function getAmmo(id: string): AmmoDef {
  return AMMO.find((ammo) => ammo.id === id) ?? AMMO[0];
}
