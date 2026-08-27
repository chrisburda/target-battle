# Target Battle

**[Play it in your browser](https://chrisburda.github.io/target-battle/)** — no install, works on desktop and mobile.

A hot-seat artillery game for 1–4 players. You pick **who to hit**; the **power
interval** decides whether you actually hit them.

There is no angle control. Choose a target and the throw solves its own arc — a dotted
line shows exactly where a *perfect* shot lands. Then hold a target wattage for a few
seconds by tapping the spacebar. How close you ride that number decides your shot's
speed, its wobble, and its damage. Over the target and it sails long, under and it drops
short, ragged and it drifts off line.

The only decisions are **who**, **what to throw**, and **how well you hold the number**.

The spacebar is a stand-in. The whole point of the mechanic is that it maps onto an
**indoor cycling trainer**: tapping produces watts through a leaky integrator, so
holding 250 W needs a steady cadence rather than one burst. Swapping the input is a
one-line change (see *Trainer integration* below).

---

## Running it locally

```bash
npm install
npm run dev        # http://127.0.0.1:5188
```

Production:

```bash
npm run build
npm run preview    # http://127.0.0.1:4188
```

The build is fully static — no server, no API keys, no external asset fetches. Deploy
`dist/` to any static host. If it will not sit at the domain root, set `base` in
`vite.config.ts` to the subpath first.

---

## Controls

| | Desktop | Touch |
|---|---|---|
| Pick target | `←` `→` (or `A` `D`, `Tab`) | ◀ / ▶ buttons, or tap a card |
| Choose ammo | `1`–`5` | tap an ammo slot |
| Fire | `Enter` or `Space` | **FIRE** |
| Build power | `Space` (tap repeatedly) | **TAP!** |
| Pause | `Esc` | pause button |
| Mute | `M` | speaker button |
| Rematch (results) | `R` or `Enter` | Rematch |

---

## How a turn resolves

1. **Choose a target.** Each card shows range, the solved launch angle, and the state of
   the line:

   | Badge | Meaning |
   |---|---|
   | **CLEAR** | a perfect hold lands square on them |
   | **GRAZE** | a perfect hold only clips them — terrain or range is eating the shot |
   | **BLOCKED** | no arc reaches them at all; pick someone else or change ammo |

   The camera frames both fighters so you can see the whole line, and the arc is drawn
   for a perfect interval. Wind and terrain are already folded into the solution, and
   heavier ammo re-solves it — a War Melon that reads BLOCKED may be CLEAR as a rock.
2. **Ready.** A short countdown, then the interval opens.
3. **Interval.** Tap to build watts. Power bleeds away continuously, so you have to
   keep a cadence. The green band on the meter is the target zone; the first 0.7 s are
   a free spin-up and are not scored. From round 3 the target can *surge* mid-interval.
4. **Resolve.** The interval produces three numbers:

   | Interval output | Effect on the shot |
   |---|---|
   | mean power ÷ target | launch speed (range goes with speed squared) |
   | time-weighted accuracy | damage multiplier, 0.55× → 1.5× |
   | consistency (spread of the hold) | aim wobble, up to 9° at a score of zero |

   A score of 0.93+ is a **perfect** interval: extra damage and a gold sparkle.

Terrain is destructible. Craters reshape sightlines, drop fighters who lose the ground
under them, and can dump someone in the river.

---

## Fighters

Every perk speaks to the power mechanic, so the pick is a statement about how you
expect to ride.

Hover a fighter on the setup screen for a rotating 3D portrait. The avatars in the
picker, the roster rail and the results table are renders of the real models, baked
once at startup — not separate drawings that could drift out of sync.

| | Perk |
|---|---|
| **Pip** the Gecko | Steady Grip — 25% less aim wobble |
| **Bruno** the Tree Frog | Big Splash — 20% wider blast radius |
| **Tusk** the Wild Boar | Heavy Hitter — +15% damage, +15% wobble |
| **Sly** the Raccoon | Good Enough — wider target zone |
| **Bunker** the Tortoise | Shell Up — 20% less damage taken, slower throws |
| **Zip** the Toucan | Wind Reader — wind affects your shots half as much |

Ammo: unlimited **River Rock**, plus scarce **Coconut** (bounces twice),
**War Melon** (heavy, huge crater, short range), **Pine Cluster** (splits into three at
the apex) and **Angry Hive** (light hit, then a swarm that keeps stinging).

---

## Trainer integration

`src/power/PowerSource.ts` is the seam. Everything downstream — the scorer, the HUD
meter, the shot mapping — reads plain watts and does not care where they came from.

```ts
interface PowerSource {
  readonly watts: number;
  begin(context: PowerContext): void;
  update(deltaSeconds: number): void;
  end(): void;
}
```

Three implementations ship:

- `SpacebarPowerSource` — taps into a leaky integrator. `POWER.tapWatts × POWER.decayTau`
  is watts per tap-per-second, so the default 105 × 0.6 means ~4 taps/s holds 250 W.
- `AiPowerSource` — a simulated rider. Skill drives settle time, overshoot, drift and
  jitter; it is scored by the same scorer humans are.
- `TrainerPowerSource` — Web Bluetooth. Reads Cycling Power Measurement (`0x2A63`) with
  the FTMS Indoor Bike Data (`0x2AD2`) fallback, including the flag walk that variable
  offset needs.

To switch a human slot to a trainer, construct a `TrainerPowerSource`, `await connect()`
from a click handler, and hand it to the turn in `Game.openTurnFor` in place of
`this.spacebarSource`. **The BLE code has not been run against real hardware in this
project** — treat first pairing as a debugging session, not a smoke test. Web Bluetooth
is Chromium-only and needs a secure context.

For several riders at once you would give each slot its own source; the turn structure
already supports that. Simultaneous intervals across several trainers would need real
networking, which is out of scope here.

---

## Verification

```bash
npm run test                # Playwright: full turn on desktop keyboard + mobile touch
npm run playtest:bot        # AI-vs-AI at two skill levels + an idle-player check
npm run capture:states      # every UI state, desktop and mobile, to artifacts/screens
npm run capture:characters  # each fighter portrait to artifacts/characters
npm run inspect:canvas      # canvas pixel metrics + render budget
npm run verify:all          # build, then all of the above
```

The canvas inspector and capture scripts accept `--state` to drive a named state
deterministically:
`setup | aim | interval | flight | stress | stress4 | results`.

Against a production build, add `?qa=1` to the URL so the test hooks are exposed.

```bash
node scripts/inspect-threejs-canvas.mjs --url http://127.0.0.1:5188 --state stress4 --seed 5
```

### Measured render budget

Worst observed case is target selection with the camera pulled back to frame a long
engagement, which brings the most scenery into view.

| | Desktop (1280×720) | Mobile (iPhone 13) |
|---|---|---|
| Draw calls | 183 / 300 | 144 / 150 |
| Triangles | 415k / 750k | 125k / 300k |
| Textures | 22 / 60 | 22 / 40 |
| DPR cap | 2 | 1.5 |
| Post passes | 2 (bloom, vignette) | 1 (bloom) |
| Shadow map | 2048 | 1024 |

The mobile tier halves prop density, stops instanced foliage casting shadows, drops three
low-value prop families outright, halves character segment counts, and omits eye
catchlights and goggle lenses — each of those is its own material, so each costs a draw
call per fighter for something under a pixel on a phone. Density trims triangles but not draw calls —
every family is its own InstancedMesh regardless of instance count — so dropping whole
families is the only way to buy calls back.

### Test hooks

`window.__THREE_GAME_TEST_HOOKS__` is installed in dev, and in production only when the
page is loaded with `?qa=1`. A plain production load exposes nothing. The QA scripts add
the parameter themselves.

---

## Structure

```
src/
  core/          render loop
  game/          config (all tuning), roster, phase machine, interval scoring, ballistics
  power/         the PowerSource seam: spacebar, AI, trainer
  entities/      Fighter
  systems/       terrain, projectiles, camera, lighting, render pipeline, VFX, audio, environment
  assets/        material library, procedural textures, model factories (animals, ammo, props)
  ui/            HUD, screens, SVG icons
```

Every tunable number lives in `src/game/config.ts`.

## Notes and known limits

- **All art is code.** No meshes, textures or audio are loaded from disk; animals, props,
  terrain, sky and every sound are generated at runtime.
- **Heightfield terrain**, so no caves or overhangs. Craters lower the surface; a blast
  that would leave an overhang collapses the roof instead.
- **Characters are stylised, not realistic** — mascot-racer proportions, smooth high-poly
  forms, blinking eyes and a costume each. Getting closer to photoreal would need
  sculpted assets: the Tripo generator is installed, but `TRIPO_API_KEY` is missing and
  there is no `python3` on this machine to run its script at all.
- **No skeletal animation.** The throw rotates an arm group; there is no rig.
- **Hot-seat only.** Networked play is not implemented.
- **Portrait phones are a poor fit** for a side-on artillery view. When a shooter and
  target cannot both fit across a portrait frame, the camera falls back to sitting on the
  shooter and leaning toward the target; the target card carries the range and line
  state. Landscape is the better orientation.
- The primary button is the design system's `#da291c` fill with a white label, which
  measures 4.87:1 — AA, not the 7:1 the rest of the interface holds to. No neutral
  background lets that red reach AAA, so it is kept as specified and flagged rather than
  silently altered. Every other text pair in the HUD was measured at 7:1 or better.
